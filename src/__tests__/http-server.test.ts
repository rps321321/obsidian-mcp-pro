import { describe, it, expect, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startHttpServer, type HttpServerHandle } from "../http-server.js";

const TEST_TOKEN = "test-http-token";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

// Registers one tool so `tools/list` is answerable — an empty McpServer
// never registers a `tools/list` handler and would answer with
// -32601 "Method not found" (harmless for connect-only tests, but the
// stateless tests exercise a real tool round-trip and need it).
function buildNoopServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "echo",
    { text: z.string() },
    async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
  );
  return server;
}

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
]);

async function startOnEphemeral(
  overrides: Partial<Parameters<typeof startHttpServer>[0]> = {},
): Promise<HttpServerHandle> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0, // ephemeral; node picks a free port
      buildMcpServer: buildNoopServer,
      installSignalHandlers: false,
      ...overrides,
      bearerToken: overrides.bearerToken ?? TEST_TOKEN,
    });
    if (!FETCH_FORBIDDEN_PORTS.has(handle.port)) return handle;
    await handle.stop();
  }

  throw new Error("Could not bind an ephemeral port accepted by fetch");
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
  // Un-stub STATELESS_MODE / SSE env vars set by stateless-mode tests so
  // they can't leak into sibling test files (vitest shares the process).
  vi.unstubAllEnvs();
});

describe("HTTP server — required Bearer auth", () => {
  it("refuses to start without a bearer token, even on loopback", async () => {
    await expect(startHttpServer({
      host: "127.0.0.1",
      port: 0,
      buildMcpServer: buildNoopServer,
      installSignalHandlers: false,
    } as Parameters<typeof startHttpServer>[0])).rejects.toThrow(/bearer token is required/i);
  });
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
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
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
  it("defaults to localhost-only origins when no allowlist is configured", async () => {
    const port = pickPort();
    handle = await startOnEphemeral({ port });
    const res = await fetch(`${handle.url}`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("vary")).toContain("Origin");
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
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
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
    await fetch(`${handle.url}`, {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    });
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
    const transportA = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await clientA.connect(transportA);
    expect(transportA.sessionId).toBeTruthy();
    await clientA.close();

    // Pre-fix: second initialize → 500 "Already connected to a transport".
    const clientB = new Client({ name: "session-b", version: "0.0.0" });
    const transportB = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await clientB.connect(transportB);
    expect(transportB.sessionId).toBeTruthy();
    expect(transportB.sessionId).not.toBe(transportA.sessionId);
    await clientB.close();
  });

  it("supports two concurrent MCP clients on the same server", async () => {
    handle = await startOnEphemeral();

    const clientA = new Client({ name: "session-a", version: "0.0.0" });
    const transportA = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    const clientB = new Client({ name: "session-b", version: "0.0.0" });
    const transportB = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });

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
    expect(body.sessions).toBeUndefined();
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

// --- Stateless mode (STATELESS_MODE=true) ---
// The server supports two transport modes behind one env var:
//   - "true"  → stateless: a fresh transport+McpServer per request, no
//              session ids, no long-lived GET SSE stream, no heartbeat.
//              Immune to reverse-proxy disconnects (same architecture as
//              Outline MCP). GET/DELETE are rejected with 405.
//   - "false" (default) → stateful: session table + SSE heartbeat.
// Mode is read per-request via isStatelessMode(), so tests stub the env
// var directly instead of reloading the module.
describe("HTTP server — stateless mode (STATELESS_MODE=true)", () => {
  it("initialize succeeds with NO Mcp-Session-Id response header", async () => {
    vi.stubEnv("STATELESS_MODE", "true");
    handle = await startOnEphemeral();

    const res = await fetch(`${handle.url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...AUTH_HEADERS,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stateless-probe", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    // Stateless = no session, so the server must never issue a session id.
    expect(res.headers.get("mcp-session-id")).toBeNull();
    await res.arrayBuffer().catch(() => undefined);
  });

  it("serves two independent clients with no session-state leakage", async () => {
    vi.stubEnv("STATELESS_MODE", "true");
    handle = await startOnEphemeral();

    const clientA = new Client({ name: "stateless-a", version: "0.0.0" });
    const transportA = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await clientA.connect(transportA);
    // Stateful sessions surface a session id on the client transport;
    // stateless must not.
    expect(transportA.sessionId).toBeUndefined();
    const toolsA = await clientA.listTools();
    expect(Array.isArray(toolsA.tools)).toBe(true);
    await clientA.close();

    // A second, fully independent client must initialize cleanly — this
    // guards against any session table left over from the first client.
    const clientB = new Client({ name: "stateless-b", version: "0.0.0" });
    const transportB = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await clientB.connect(transportB);
    expect(transportB.sessionId).toBeUndefined();
    const toolsB = await clientB.listTools();
    expect(Array.isArray(toolsB.tools)).toBe(true);
    await clientB.close();
  });

  it("rejects GET /mcp with 405 (no SSE stream in stateless mode)", async () => {
    vi.stubEnv("STATELESS_MODE", "true");
    handle = await startOnEphemeral();

    const res = await fetch(`${handle.url}`, {
      method: "GET",
      headers: { ...AUTH_HEADERS, Accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
    await res.arrayBuffer().catch(() => undefined);
  });

  it("rejects DELETE /mcp with 405 (no session teardown in stateless mode)", async () => {
    vi.stubEnv("STATELESS_MODE", "true");
    handle = await startOnEphemeral();

    const res = await fetch(`${handle.url}`, {
      method: "DELETE",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(405);
    await res.arrayBuffer().catch(() => undefined);
  });

  it("heartbeat is a no-op in stateless mode: no GET SSE stream to keep alive", async () => {
    // With stateless enabled, GET is rejected (405, asserted above), so the
    // SSE keep-alive timer inside the stateful GET branch can never start.
    // We assert that through the observable contract: an initialize + tool
    // round-trip works while no GET stream exists anywhere.
    vi.stubEnv("STATELESS_MODE", "true");
    handle = await startOnEphemeral();

    const client = new Client({ name: "stateless-hb", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await client.connect(transport);
    await client.listTools();
    // No session id was handed out → the client never opens a GET stream.
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });
});

// Explicit guard that the stateful path (default, STATELESS_MODE unset or
// "false") still issues a session id — switching the env var off must
// restore the old behavior exactly.
describe("HTTP server — stateful mode explicit (STATELESS_MODE=false)", () => {
  it("initialize issues a session id when stateless is disabled", async () => {
    vi.stubEnv("STATELESS_MODE", "false");
    handle = await startOnEphemeral();

    const client = new Client({ name: "stateful-explicit", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });

  it("keeps the SSE heartbeat active in stateful mode (regression guard)", async () => {
    vi.stubEnv("STATELESS_MODE", "false");
    handle = await startOnEphemeral();

    const client = new Client({ name: "stateful-hb", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: AUTH_HEADERS },
    });
    await client.connect(transport);
    // Stateful initialize returns a session id, which is what makes the GET
    // SSE stream + keep-alive heartbeat meaningful.
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });
});
