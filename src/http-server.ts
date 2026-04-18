import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  bearerToken?: string;
  buildMcpServer: () => McpServer;
  /** Install SIGINT/SIGTERM handlers + exit the process on shutdown. Default
   *  `true` for CLI use. Set `false` when embedding (e.g. inside an Obsidian
   *  plugin) so stopping the server doesn't kill the host process. */
  installSignalHandlers?: boolean;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
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

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const mcpServer = opts.buildMcpServer();

  // DNS rebinding protection: restrict Host header to the bound interface +
  // localhost aliases. Browsers attacking via dns-rebinding will present a
  // third-party hostname and be rejected.
  const allowedHosts = [
    `${opts.host}:${opts.port}`,
    `127.0.0.1:${opts.port}`,
    `localhost:${opts.port}`,
    `[::1]:${opts.port}`,
  ];

  const httpServer = createServer(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      if (url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", sessions: transports.size });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (opts.bearerToken) {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token !== opts.bearerToken) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-mcp-pro"');
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await readBody(req);

        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res, body);
          return;
        }

        if (!sessionId && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
            },
            allowedHosts,
            enableDnsRebindingProtection: true,
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await mcpServer.connect(transport);
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
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      console.error("[obsidian-mcp-pro] HTTP error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => resolve());
  });

  console.error(`[obsidian-mcp-pro] HTTP server listening on http://${opts.host}:${opts.port}/mcp`);
  if (opts.bearerToken) {
    console.error(`[obsidian-mcp-pro] Bearer auth required`);
  }

  const stop = async (): Promise<void> => {
    console.error(`[obsidian-mcp-pro] Shutting down HTTP server...`);
    for (const t of transports.values()) {
      try { await t.close(); } catch { /* ignore */ }
    }
    transports.clear();
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
    port: opts.port,
    url: `http://${opts.host}:${opts.port}/mcp`,
    stop,
  };
}
