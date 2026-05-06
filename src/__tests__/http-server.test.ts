import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

// Previously this helper randomly picked a port in [40000, 60000) to avoid
// collisions, but under vitest's parallel workers the random choice still
// collided a few times per hundred runs. The HTTP handle now echoes the real
// OS-assigned port, so tests bind `port: 0` and read `handle.port` instead.
// Keep the function for API compatibility with the older test cases.
function pickPort(): number {
  return 0;
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

    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
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
  it("returns 404 for paths other than /mcp, /health, and /version", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port });
    const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("HTTP server — CORS allowlist", () => {
  it("defaults to `*` when no allowlist is configured", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port });
    const res = await fetch(`${handle.url}`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("reflects the request origin when it's in the allowlist", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({
      port,
      allowedOrigins: ["https://app.example", "https://claude.ai"],
    });
    const res = await fetch(`${handle.url}`, {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("does not reflect origins outside the allowlist", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({
      port,
      allowedOrigins: ["https://app.example"],
    });
    const res = await fetch(`${handle.url}`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("sets Vary: Origin whenever the allowlist is configured, even for non-matching origins", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({
      port,
      allowedOrigins: ["https://app.example"],
    });
    const res = await fetch(`${handle.url}`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    // Vary: Origin must fire for all cache-visible origin-dependent responses
    // so a shared cache never pins one origin to another origin's request.
    expect(res.headers.get("vary")).toContain("Origin");
  });
});

describe("HTTP server — rate limiting", () => {
  it("returns 429 after exceeding the per-minute quota", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port, rateLimitPerMinute: 3 });

    const url = `${handle.url}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const hit = async (): Promise<number> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      // Drain the body so the socket can be reused / freed cleanly.
      await res.arrayBuffer().catch(() => undefined);
      return res.status;
    };

    // First 3 go through (status depends on MCP handshake but isn't 429).
    for (let i = 0; i < 3; i++) {
      const status = await hit();
      expect(status).not.toBe(429);
    }
    const blocked = await hit();
    expect(blocked).toBe(429);
  });

  it("exempts /health and /version from rate limiting", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port, rateLimitPerMinute: 1 });
    // Burn the one allowed /mcp request.
    await fetch(`${handle.url}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    // Health and version still respond 200 even though the window is exhausted.
    for (let i = 0; i < 5; i++) {
      const h = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(h.status).toBe(200);
      const v = await fetch(`http://127.0.0.1:${handle.port}/version`);
      expect(v.status).toBe(200);
    }
  });
});

// Regression for https://github.com/rps321321/obsidian-mcp-pro/issues/8.
// The HTTP server used to share one `McpServer` across the whole process,
// so the SDK's underlying `Protocol` rejected the second `connect()` with
// "Already connected to a transport" and every reconnect / second concurrent
// client returned HTTP 500. Each `initialize` now builds a fresh `McpServer`.
describe("HTTP server: multi-session lifecycle (regression for #8)", () => {
  it("accepts two sequential MCP clients without 500ing the second initialize", async () => {
    handle = await startOnEphemeral();

    const clientA = new Client({ name: "session-a", version: "0.0.0" });
    const transportA = new StreamableHTTPClientTransport(new URL(handle.url));
    await clientA.connect(transportA);
    expect(transportA.sessionId).toBeTruthy();
    await clientA.close();

    // Pre-fix: second initialize → 500 "Already connected to a transport".
    const clientB = new Client({ name: "session-b", version: "0.0.0" });
    const transportB = new StreamableHTTPClientTransport(new URL(handle.url));
    await clientB.connect(transportB);
    expect(transportB.sessionId).toBeTruthy();
    expect(transportB.sessionId).not.toBe(transportA.sessionId);
    await clientB.close();
  });

  it("supports two concurrent MCP clients on the same server", async () => {
    handle = await startOnEphemeral();

    const clientA = new Client({ name: "session-a", version: "0.0.0" });
    const transportA = new StreamableHTTPClientTransport(new URL(handle.url));
    const clientB = new Client({ name: "session-b", version: "0.0.0" });
    const transportB = new StreamableHTTPClientTransport(new URL(handle.url));

    // Connect both before either closes. This exercises the
    // singleton-Protocol failure mode, where the second `connect()` happens
    // while the first session's transport is still attached.
    await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);

    expect(transportA.sessionId).toBeTruthy();
    expect(transportB.sessionId).toBeTruthy();
    expect(transportA.sessionId).not.toBe(transportB.sessionId);

    await Promise.all([clientA.close(), clientB.close()]);
  });
});

describe("HTTP server — /version", () => {
  it("returns the configured version without auth", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port, bearerToken: "t", version: "9.9.9-test" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe("9.9.9-test");
  });

  it("/health includes the version when configured", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port, version: "1.2.3" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; sessions?: number };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.2.3");
    // Without a bearer token configured, the live session count is part
    // of the /health response so local-only operators can see usage.
    expect(typeof body.sessions).toBe("number");
  });

  // Regression for the v1.8.1-audit finding: when a Bearer token is
  // configured, /health must NOT leak the live session count to
  // unauthenticated callers (the endpoint is exempt from auth so monitors
  // can still reach it). Status + version stay; sessions disappears.
  it("/health omits the session count when bearerToken is set", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port, bearerToken: "secret", version: "1.2.3" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; sessions?: number };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.2.3");
    expect(body.sessions).toBeUndefined();
  });
});
