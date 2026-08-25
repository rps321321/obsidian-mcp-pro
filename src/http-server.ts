import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./lib/logger.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Required for HTTP transport. Use MCP_HTTP_TOKEN in the CLI path. */
  bearerToken: string;
  buildMcpServer: () => McpServer;
  /** Install SIGINT/SIGTERM handlers + exit the process on shutdown. Default
   *  `true` for CLI use. Set `false` when embedding (e.g. inside an Obsidian
   *  plugin) so stopping the server doesn't kill the host process. */
  installSignalHandlers?: boolean;
  /** Reported on `/health` and `/version`. Defaults to empty string. */
  version?: string;
  /** Allowed CORS origins. Defaults to localhost-only patterns
   *  (`["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]`).
   *  Use an explicit list (e.g. `["https://claude.ai"]`) for browser-facing
   *  deployments. Pass `["*"]` to allow all origins only when Bearer auth is
   *  configured.
   *  Requests from other origins still succeed (CORS is a browser-only
   *  restriction) but the browser will reject the response. */
  allowedOrigins?: string[];
  /** Max requests per minute per client IP. 0 or undefined disables. */
  rateLimitPerMinute?: number;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Per-request wall-clock cap. A hung tool handler (e.g. a stuck filesystem
// or an infinite-loop plugin) would otherwise pin the socket forever — idle
// session sweep is 1h and doesn't help while the request is still "active".
// Streamable HTTP responses stay open for the duration of a tool call, so
// this must be generous enough for large vault scans (search, link graph).
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const installedSignalHandlers = new Map<NodeJS.Signals, () => void>();

// --- SSE keep-alive 心跳（环境变量可配置，便于调试）---
// SSE_KEEPALIVE_ENABLED      "true"(默认)/"false" —— 关闭时完全不启动心跳，无任何副作用
// SSE_KEEPALIVE_INTERVAL_MS  心跳间隔毫秒，默认 15000；<=0 或非法值视为关闭心跳
const SSE_KEEPALIVE_ENABLED =
  (process.env.SSE_KEEPALIVE_ENABLED ?? "true").trim().toLowerCase() !== "false";
const parsedKeepaliveInterval = Number(process.env.SSE_KEEPALIVE_INTERVAL_MS ?? "15000");
const SSE_KEEPALIVE_INTERVAL_MS =
  Number.isFinite(parsedKeepaliveInterval) && parsedKeepaliveInterval > 0
    ? parsedKeepaliveInterval
    : 0;

// --- Stateless 模式（可选，治本方案；与 Outline MCP 同款架构）---
// STATELESS_MODE=true 时启用无状态模式：
//   - 每次请求独立创建 transport（sessionIdGenerator: undefined），无 sessionId、无长连接、无 GET SSE 流
//   - 彻底免疫反代/网络掐断导致的断联，无需心跳
// 关闭（默认 false）时使用 stateful + SSE 心跳模式（现有逻辑原样保留）。
// 两种模式互不干扰，切换仅需改环境变量。
// 用函数而非模块级常量：每次请求读取 process.env，便于测试 stub 与运行时热切换。
// 无副作用保证：
//   - stateless 时 GET/DELETE 走 405 分支，不会误入 stateful 的 session/SSE/心跳逻辑
//   - stateless 时心跳不启动（心跳只存在于 stateful 的 GET SSE 流内）
//   - stateless 时 session 表（transports/lastActivity）不参与，sweeper 仅清理限流窗口
function isStatelessMode(): boolean {
  const raw = process.env.STATELESS_MODE ?? "false";
  return raw.trim().toLowerCase() === "true";
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

function declaredBodyTooLarge(req: IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength !== "string" || !/^\d+$/.test(contentLength)) return false;
  return BigInt(contentLength) > BigInt(MAX_BODY_BYTES);
}

function isJsonContentType(contentType: string | string[] | undefined): boolean {
  if (typeof contentType !== "string") return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering and let the caller return 413 immediately; keep the
        // request stream flowing so the socket can drain without a hard reset.
        fail(new BodyTooLargeError());
        req.resume();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => fail(err));
  });
}

function setSecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  // Add HSTS when the connection is over TLS (direct or behind a
  // TLS-terminating reverse proxy that sets the standard header).
  const isTls =
    (req.socket as unknown as { encrypted?: boolean }).encrypted ||
    req.headers["x-forwarded-proto"] === "https";
  if (isTls) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return null;
  }
}

// Constant-time string compare that does not leak the expected token's
// length. Both inputs are padded to a fixed comparison width (the longer
// of the two) before `timingSafeEqual`, so the compare time is the same
// whether or not the supplied token's length matches the expected token.
// Length-mismatch is recorded separately and returned without an early
// exit, so an attacker can't binary-search the expected length via timing.
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const lengthsMatch = aBuf.length === bBuf.length;
  const width = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(width);
  const bPad = Buffer.alloc(width);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const bytesMatch = timingSafeEqual(aPad, bPad);
  return lengthsMatch && bytesMatch;
}

// Check whether an origin matches an allowlist entry. Supports a trailing
// `:*` wildcard that matches any port (e.g. `http://localhost:*` matches
// `http://localhost:3000`). Exact strings match as before.
function originMatches(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (pattern.endsWith(":*")) {
    const base = pattern.slice(0, -2); // "http://localhost"
    return origin === base || origin.startsWith(`${base}:`);
  }
  return false;
}

function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes("*")) return true;
  return allowedOrigins.some((pattern) => originMatches(origin, pattern));
}

function setCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[],
): void {
  // Reflect the request origin only when it matches the allowlist; fall back
  // to the first allowlist entry otherwise. `*` short-circuits to the
  // permissive default.
  const requestOrigin = req.headers.origin;
  const allowAny = allowedOrigins.includes("*");
  let allowOrigin = "*";
  if (!allowAny) {
    // Always set `Vary: Origin` when the ACAO value depends on the request
    // origin - otherwise a shared cache may serve a response with one origin
    // pinned to a different origin's request. This must fire regardless of
    // whether *this particular* origin matched the allowlist.
    res.setHeader("Vary", "Origin");
    if (requestOrigin && allowedOrigins.some((p) => originMatches(requestOrigin, p))) {
      allowOrigin = requestOrigin;
    } else {
      allowOrigin = allowedOrigins[0] ?? "";
    }
  }
  if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

// Sliding-window rate limiter keyed by client IP. In-memory only — fine for
// a single-node deployment, not shared across replicas. Intentionally simple:
// no dep on `express-rate-limit`, no bucket refill math, just an array of
// request timestamps per IP pruned on read.
class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}
  check(ip: string): boolean {
    const now = Date.now();
    const floor = now - this.windowMs;
    const times = this.windows.get(ip) ?? [];
    // Prune expired entries in place (amortized O(1) per request).
    let i = 0;
    while (i < times.length && times[i]! <= floor) i++;
    const live = i === 0 ? times : times.slice(i);
    if (live.length >= this.limit) {
      this.windows.set(ip, live);
      return false;
    }
    live.push(now);
    this.windows.set(ip, live);
    return true;
  }
  sweep(): void {
    const floor = Date.now() - this.windowMs;
    for (const [ip, times] of this.windows) {
      const kept = times.filter((t) => t > floor);
      if (kept.length === 0) this.windows.delete(ip);
      else this.windows.set(ip, kept);
    }
  }
}

function clientIp(req: IncomingMessage): string {
  // No X-Forwarded-For trust here: the server binds to localhost by default
  // and does not know whether a reverse proxy is terminating TLS. Operators
  // running behind a proxy should configure rate limiting at the proxy layer.
  const addr = req.socket.remoteAddress ?? "unknown";
  // On dual-stack systems a client connecting via IPv4 is surfaced as
  // `::ffff:1.2.3.4` — normalize so the v4 and v4-mapped-v6 paths share a
  // single rate-limit bucket instead of letting a client double its quota.
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const bearerToken = opts.bearerToken?.trim();
  if (opts.bearerToken !== undefined && !bearerToken) {
    throw new Error("HTTP bearer token cannot be empty");
  }
  if (!bearerToken) {
    throw new Error("HTTP bearer token is required. Set MCP_HTTP_TOKEN in the CLI or pass bearerToken when embedding.");
  }
  const allowedOrigins = opts.allowedOrigins && opts.allowedOrigins.length > 0
    ? opts.allowedOrigins
    : ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastActivity = new Map<string, number>();
  const touch = (sid: string): void => { lastActivity.set(sid, Date.now()); };
  // One `McpServer` per session: the underlying SDK `Protocol` rejects a
  // second `connect()` while a transport is still attached, so a singleton
  // 500s every reconnect and every concurrent client past the first. Each
  // `initialize` builds a fresh server below; GC reclaims it once the
  // transport closes (Protocol._onclose clears the transport reference).
  // See https://github.com/rps321321/obsidian-mcp-pro/issues/8.
  if (allowedOrigins.includes("*")) {
    log.warn("CORS configured with wildcard origin '*'. Consider restricting to specific origins for production deployments.");
  }
  const rateLimiter = opts.rateLimitPerMinute && opts.rateLimitPerMinute > 0
    ? new RateLimiter(opts.rateLimitPerMinute)
    : null;

  // Evict sessions that have been idle past the timeout so dropped clients
  // (crash, network loss, no DELETE) don't leak transports forever.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, ts] of lastActivity) {
      if (now - ts > SESSION_IDLE_TIMEOUT_MS) {
        const t = transports.get(sid);
        if (t) { void t.close().catch(() => undefined); }
        transports.delete(sid);
        lastActivity.delete(sid);
      }
    }
    rateLimiter?.sweep();
  }, SESSION_SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  // DNS rebinding protection: restrict Host header to the bound interface +
  // localhost aliases. Browsers attacking via dns-rebinding will present a
  // third-party hostname and be rejected. Populated after `listen()` so we
  // know the bound port; this matters when callers pass `port: 0` (tests,
  // embedders) and the OS assigns one. The array reference is captured by
  // each `StreamableHTTPServerTransport` constructor and read on every
  // request, so we MUST mutate this array in place (push) rather than
  // re-assigning the binding: a new array would be invisible to transports
  // that already grabbed the original reference, silently disabling
  // DNS-rebinding protection.
  const allowedHosts: string[] = [];

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Cap wall-clock time for POST requests only. GET is used by the
    // Streamable HTTP transport for long-lived SSE streams that intentionally
    // go write-silent between events — `socket.setTimeout` would reap them
    // as "idle" after 2 minutes and break valid clients. DELETE is a
    // fire-and-forget session teardown and doesn't need a timeout.
    if (req.method === "POST") {
      const onTimeout = (): void => {
        if (!res.headersSent) {
          res.setHeader("Connection", "close");
          sendJson(res, 408, { error: "Request timeout" });
        }
        req.destroy();
      };
      req.setTimeout(REQUEST_TIMEOUT_MS, onTimeout);
      res.setTimeout(REQUEST_TIMEOUT_MS, onTimeout);
    }

    setCors(req, res, allowedOrigins);
    setSecurityHeaders(req, res);
    const url = parseRequestUrl(req);
    if (!url) {
      log.warn("Rejected malformed HTTP request URL", {
        method: req.method,
        path: req.url ?? "",
        ip: clientIp(req),
      });
      sendJson(res, 400, { error: "Malformed request URL" });
      return;
    }
    const requestOrigin = req.headers.origin;
    if (typeof requestOrigin === "string" && !originAllowed(requestOrigin, allowedOrigins)) {
      log.warn("Rejected request from disallowed Origin", {
        origin: requestOrigin,
        method: req.method,
        path: req.url ?? "",
        ip: clientIp(req),
      });
      sendJson(res, 403, { error: "Origin not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate-limit before any other work (auth, body read) so abusive clients
    // can't waste CPU or memory. Health/version endpoints are exempt — they
    // need to stay reachable for monitoring even under load.
    if (rateLimiter) {
      const ip = clientIp(req);
      const exempt = url.pathname === "/health" || url.pathname === "/version";
      if (!exempt && !rateLimiter.check(ip)) {
        res.setHeader("Retry-After", "60");
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }
    }

    if (url.pathname !== "/mcp") {
      if (url.pathname === "/health") {
        // When a Bearer token is configured (production deployments),
        // `/health` stays unauthenticated for monitoring but must not leak
        // operational state to anonymous probes. Drop the live session
        // count in that mode; locally it's still useful for debugging.
        const body: Record<string, unknown> = {
          status: "ok",
          version: opts.version ?? "",
        };
        sendJson(res, 200, body);
        return;
      }
      if (url.pathname === "/version") {
        // GET stays unauthenticated for monitoring probes (same shape as
        // /health). Non-GET methods are non-sensical for a read-only
        // version endpoint and, when a Bearer token is configured, must
        // require it — anonymous POSTs were previously a free
        // unauthenticated reflection point.
        if (req.method !== "GET" && bearerToken) {
          const header = req.headers.authorization ?? "";
          const token = header.startsWith("Bearer ") ? header.slice(7) : "";
          if (!constantTimeEqual(token, bearerToken)) {
            res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-mcp-pro"');
            sendJson(res, 401, { error: "Unauthorized" });
            return;
          }
        }
        sendJson(res, 200, { version: opts.version ?? "" });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (bearerToken) {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!constantTimeEqual(token, bearerToken)) {
        log.warn("Authentication failure", {
          method: req.method,
          path: url.pathname,
          ip: clientIp(req),
          reason: header ? "invalid token" : "missing token",
        });
        res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-mcp-pro"');
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && !UUID_RE.test(sessionId)) {
        sendJson(res, 400, { error: "Invalid session ID format" });
        return;
      }

      if (req.method === "POST") {
        // MCP Streamable HTTP requires JSON bodies. Reject anything else
        // before reading the stream: avoids buffering up to 4 MB of
        // non-JSON data just to produce a parse error, and gives clients
        // a clearer 415 ("the server understands the request method but
        // the media type is unsupported") than a generic 400.
        if (!isJsonContentType(req.headers["content-type"])) {
          sendJson(res, 415, { error: "Unsupported Media Type: expected application/json" });
          return;
        }
        if (declaredBodyTooLarge(req)) {
          req.resume();
          sendJson(res, 413, { error: "Request body too large" });
          return;
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, 413, { error: "Request body too large" });
            return;
          }
          throw err;
        }

        // --- Stateless 模式（STATELESS_MODE=true）：每个请求独立创建 transport ---
        // 不生成 sessionId，不做 session 校验，每次请求自包含；GET/DELETE 走 405 分支。
        // 与 Outline MCP 完全一致，天然免疫反代掐断/客户端重连导致的断联。
        if (isStatelessMode()) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            allowedHosts,
            allowedOrigins,
            enableDnsRebindingProtection: true,
          });
          const sessionServer = opts.buildMcpServer();
          await sessionServer.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        // --- Stateful 模式（默认）：session 表 + 心跳（原逻辑）---
        if (sessionId && transports.has(sessionId)) {
          touch(sessionId);
          await transports.get(sessionId)!.handleRequest(req, res, body);
          return;
        }

        if (!sessionId && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              touch(sid);
            },
            allowedHosts,
            allowedOrigins,
            enableDnsRebindingProtection: true,
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              lastActivity.delete(transport.sessionId);
            }
          };
          const sessionServer = opts.buildMcpServer();
          try {
            await sessionServer.connect(transport);
            await transport.handleRequest(req, res, body);
          } catch (err) {
            // If init throws after the SDK already assigned a session id
            // (e.g. handleRequest fails mid-stream), the `onclose` cleanup
            // may not fire — drop the bookkeeping ourselves so a leaked
            // transport doesn't accumulate in the maps and eventually hit
            // the idle sweeper hours later.
            const sid = transport.sessionId;
            if (sid) {
              transports.delete(sid);
              lastActivity.delete(sid);
            }
            throw err;
          }
          return;
        }

        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid session or non-initialize request without session (No valid session ID provided)" },
          id: null,
        });
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        // Stateless 模式：无 session 概念，不支持 GET SSE 长连接 / DELETE session。
        // 客户端在 stateless 下不会建立 GET 流（initialize 无 sessionId 响应），
        // 无长连接 = 无被反代掐断风险，也无需心跳。
        if (isStatelessMode()) {
          sendJson(res, 405, {
            error: "Method not allowed in stateless mode. Use POST for MCP requests.",
          });
          return;
        }

        if (!sessionId || !transports.has(sessionId)) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }
        touch(sessionId);
        const transport = transports.get(sessionId)!;

        // --- SSE keep-alive 心跳（可配置）：GET SSE 流建立后按 SSE_KEEPALIVE_INTERVAL_MS
        //     周期发送 SSE 注释行，防止中间代理/NAT/反代因静默超时掐断长连接。
        //     注意：不能依赖"首次写数据后启动"——若无推送事件，服务端可能长时间不写任何字节。 ---
        if (req.method === "GET") {
          // 关闭心跳（enabled=false 或 interval<=0）：完全跳过，不创建 timer、不注册监听、不写字节
          if (SSE_KEEPALIVE_ENABLED && SSE_KEEPALIVE_INTERVAL_MS > 0) {
            const keepAliveTimer = setInterval(() => {
              if (!res.writableEnded) {
                try {
                  res.write(":\n\n"); // SSE 注释行，客户端自动忽略
                } catch {
                  /* 忽略写失败，由 close/finish 清理 */
                }
              }
            }, SSE_KEEPALIVE_INTERVAL_MS);
            keepAliveTimer.unref?.();
            const stopKeepAlive = () => clearInterval(keepAliveTimer);
            res.on("close", stopKeepAlive);
            res.on("finish", stopKeepAlive);
          }
        }

        await transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      log.error("HTTP error", { err: err as Error });
      if (!res.headersSent) {
        // Do not forward internal error messages to HTTP clients — they may
        // contain file paths or SDK internals. Full detail is logged above.
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  };

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => resolve());
  });

  const keepaliveActive = SSE_KEEPALIVE_ENABLED && SSE_KEEPALIVE_INTERVAL_MS > 0;
  log.info(
    keepaliveActive
      ? `SSE keep-alive enabled (interval=${SSE_KEEPALIVE_INTERVAL_MS}ms)`
      : "SSE keep-alive disabled",
    { sseKeepAliveEnabled: keepaliveActive, sseKeepAliveIntervalMs: SSE_KEEPALIVE_INTERVAL_MS }
  );

  // When port 0 is passed (OS-assigned port, used by tests and embedders
  // that don't care about a specific port), surface the actual bound port
  // so callers can build URLs that work.
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  allowedHosts.push(
    `${opts.host}:${boundPort}`,
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  );

  log.info(`HTTP server listening`, {
    url: `http://${opts.host}:${boundPort}/mcp`,
    bearerAuth: Boolean(bearerToken),
    allowedOrigins: allowedOrigins.join(","),
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 0,
  });
  const installSignals = opts.installSignalHandlers ?? true;
  const onSignal = (): void => {
    void stop().finally(() => {
      process.exit(0);
    });
  };

  const stop = async (): Promise<void> => {
    log.info(`Shutting down HTTP server`);
    clearInterval(sweeper);
    for (const t of transports.values()) {
      try { await t.close(); } catch { /* ignore */ }
    }
    transports.clear();
    lastActivity.clear();
    // `httpServer.close()` waits for all active sockets to close on their
    // own — keep-alive idle connections would otherwise pin the server
    // open indefinitely. `closeAllConnections` (Node >=18.2) tears down
    // sockets that aren't currently mid-response so `close()` can return.
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (installSignals) {
      for (const sig of SIGNALS) {
        if (installedSignalHandlers.get(sig) === onSignal) {
          process.off(sig, onSignal);
          installedSignalHandlers.delete(sig);
        }
      }
    }
  };

  if (installSignals) {
    for (const sig of SIGNALS) {
      const previous = installedSignalHandlers.get(sig);
      if (previous) process.off(sig, previous);
      process.on(sig, onSignal);
      installedSignalHandlers.set(sig, onSignal);
    }
  }

  return {
    host: opts.host,
    port: boundPort,
    url: `http://${opts.host}:${boundPort}/mcp`,
    stop,
  };
}
