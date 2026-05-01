import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./lib/logger.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  bearerToken?: string;
  buildMcpServer: () => McpServer;
  /** Install SIGINT/SIGTERM handlers + exit the process on shutdown. Default
   *  `true` for CLI use. Set `false` when embedding (e.g. inside an Obsidian
   *  plugin) so stopping the server doesn't kill the host process. */
  installSignalHandlers?: boolean;
  /** Reported on `/health` and `/version`. Defaults to empty string. */
  version?: string;
  /** Allowed CORS origins. Defaults to `["*"]` to match prior behavior. Use
   *  an explicit list (e.g. `["https://claude.ai"]`) to tighten for
   *  browser-facing deployments. Requests from other origins still succeed
   *  (CORS is a browser-only restriction) but the browser will reject the
   *  response. */
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

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Per-request wall-clock cap. A hung tool handler (e.g. a stuck filesystem
// or an infinite-loop plugin) would otherwise pin the socket forever — idle
// session sweep is 1h and doesn't help while the request is still "active".
// Streamable HTTP responses stay open for the duration of a tool call, so
// this must be generous enough for large vault scans (search, link graph).
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let exceeded = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep reading + discarding so the request stream
        // drains cleanly. Destroying the socket here races with the 413
        // response write and produces noisy `write after end` errors.
        exceeded = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (exceeded) return reject(new BodyTooLargeError());
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Constant-time string compare. `timingSafeEqual` requires equal-length
// buffers, so pad one side to the other's length — this still reveals the
// expected token length, but not the byte content, and avoids the early-exit
// behavior of `!==`.
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still compare same-length buffers so the compare takes similar time.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
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
    // origin — otherwise a shared cache may serve a response with one origin
    // pinned to a different origin's request. This must fire regardless of
    // whether *this particular* origin matched the allowlist.
    res.setHeader("Vary", "Origin");
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
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
    while (i < times.length && times[i] <= floor) i++;
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
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastActivity = new Map<string, number>();
  const touch = (sid: string): void => { lastActivity.set(sid, Date.now()); };
  // One `McpServer` per session: the underlying SDK `Protocol` rejects a
  // second `connect()` while a transport is still attached, so a singleton
  // 500s every reconnect and every concurrent client past the first. Each
  // `initialize` builds a fresh server below; GC reclaims it once the
  // transport closes (Protocol._onclose clears the transport reference).
  // See https://github.com/rps321321/obsidian-mcp-pro/issues/8.
  const allowedOrigins = opts.allowedOrigins && opts.allowedOrigins.length > 0
    ? opts.allowedOrigins
    : ["*"];
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
  // each `StreamableHTTPServerTransport` and read on every request, so
  // re-assigning it post-listen propagates to all subsequent transports.
  let allowedHosts: string[] = [];

  const httpServer = createServer(async (req, res) => {
    // Cap wall-clock time for POST requests only. GET is used by the
    // Streamable HTTP transport for long-lived SSE streams that intentionally
    // go write-silent between events — `socket.setTimeout` would reap them
    // as "idle" after 2 minutes and break valid clients. DELETE is a
    // fire-and-forget session teardown and doesn't need a timeout.
    if (req.method === "POST") {
      req.setTimeout(REQUEST_TIMEOUT_MS);
      res.setTimeout(REQUEST_TIMEOUT_MS);
    }

    setCors(req, res, allowedOrigins);
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
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const exempt = url.pathname === "/health" || url.pathname === "/version";
      if (!exempt && !rateLimiter.check(ip)) {
        res.setHeader("Retry-After", "60");
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      if (url.pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          sessions: transports.size,
          version: opts.version ?? "",
        });
        return;
      }
      if (url.pathname === "/version") {
        sendJson(res, 200, { version: opts.version ?? "" });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (opts.bearerToken) {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!constantTimeEqual(token, opts.bearerToken)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-mcp-pro"');
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
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
            enableDnsRebindingProtection: true,
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              lastActivity.delete(transport.sessionId);
            }
          };
          const sessionServer = opts.buildMcpServer();
          await sessionServer.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid session or non-initialize request without session" },
          id: null,
        });
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !transports.has(sessionId)) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }
        touch(sessionId);
        await transports.get(sessionId)!.handleRequest(req, res);
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
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => resolve());
  });

  // When port 0 is passed (OS-assigned port, used by tests and embedders
  // that don't care about a specific port), surface the actual bound port
  // so callers can build URLs that work.
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  allowedHosts = [
    `${opts.host}:${boundPort}`,
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ];

  log.info(`HTTP server listening`, {
    url: `http://${opts.host}:${boundPort}/mcp`,
    bearerAuth: Boolean(opts.bearerToken),
    allowedOrigins: allowedOrigins.join(","),
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 0,
  });

  const stop = async (): Promise<void> => {
    log.info(`Shutting down HTTP server`);
    clearInterval(sweeper);
    for (const t of transports.values()) {
      try { await t.close(); } catch { /* ignore */ }
    }
    transports.clear();
    lastActivity.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  const installSignals = opts.installSignalHandlers ?? true;
  if (installSignals) {
    const onSignal = async (): Promise<void> => {
      await stop();
      process.exit(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return {
    host: opts.host,
    port: boundPort,
    url: `http://${opts.host}:${boundPort}/mcp`,
    stop,
  };
}
