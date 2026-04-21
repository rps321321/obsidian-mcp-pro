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
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.2.3");
  });
});
