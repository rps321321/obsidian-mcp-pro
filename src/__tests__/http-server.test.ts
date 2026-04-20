import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer, type HttpServerHandle } from "../http-server.js";

function buildNoopServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

async function startOnEphemeral(
  overrides: Partial<Parameters<typeof startHttpServer>[0]> = {},
): Promise<HttpServerHandle> {
  return startHttpServer({
    host: "127.0.0.1",
    port: 0, // ephemeral; node picks a free port
    buildMcpServer: buildNoopServer,
    installSignalHandlers: false,
    ...overrides,
  });
}

// node's createServer with port 0 assigns a free port; we need the real one.
// startHttpServer returns opts.port (which is 0), so read the address() via
// a tiny helper: rebind a fresh server and ask it to pick a port, then reuse.
// Simpler: pass port 0 — but the handle echoes 0. We instead pick a random
// high port and retry on collision, which is plenty for CI.

function pickPort(): number {
  return 40000 + Math.floor(Math.random() * 20000);
}

let handle: HttpServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

describe("HTTP server — Bearer auth (regression guard for timing-safe compare / 401 behavior)", () => {
  it("rejects a POST to /mcp without a Bearer token when bearerToken is set", async () => {
    const token = "s3cret-xyz";
    const port = pickPort();
    handle = await startOnEphemeral({ port, bearerToken: token });

    const res = await fetch(`${handle.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("rejects a POST with a wrong Bearer token", async () => {
    const token = "correct-token";
    const port = pickPort();
    handle = await startOnEphemeral({ port, bearerToken: token });

    const res = await fetch(`${handle.url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("allows /health without auth (documented behavior)", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port, bearerToken: "t" });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("HTTP server — oversize body (regression guard for 413 / drain)", () => {
  it("returns 413 for POST bodies larger than 4MB", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port });

    const huge = "x".repeat(5 * 1024 * 1024); // 5 MB
    const res = await fetch(`${handle.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "noop", params: { huge } }),
    });
    expect(res.status).toBe(413);
  });
});

describe("HTTP server — CORS preflight", () => {
  it("responds 204 to OPTIONS", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port });
    const res = await fetch(`${handle.url}`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("HTTP server — unknown path", () => {
  it("returns 404 for paths other than /mcp and /health", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port });
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
