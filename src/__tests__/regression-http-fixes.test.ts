import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer, type HttpServerHandle } from "../http-server.js";

// Regression coverage for the v1.8.x HTTP audit:
//   C1 — DNS-rebinding allowedHosts ref was captured empty, silently disabling
//        Host validation (now mutated in place after listen()).
//   M1 — POST without `Content-Type: application/json` is now rejected with
//        415 before the body is buffered.
//   M2 — Non-GET requests to /version now require the bearer token when one
//        is configured (GET stays public for monitoring probes).
//   M5 — Repeated `startHttpServer` calls used to leak SIGINT/SIGTERM
//        listeners and trip MaxListenersExceededWarning at 11 boots.

function buildNoopServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

async function startOnEphemeral(
  overrides: Partial<Parameters<typeof startHttpServer>[0]> = {},
): Promise<HttpServerHandle> {
  return startHttpServer({
    host: "127.0.0.1",
    port: 0,
    buildMcpServer: buildNoopServer,
    installSignalHandlers: false,
    ...overrides,
  });
}

const handles: HttpServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) {
      try { await h.stop(); } catch { /* ignore */ }
    }
  }
});

describe("regression: malformed Host is rejected before auth and routing", () => {
  it("returns 400 instead of leaving the response open", async () => {
    const handle = await startOnEphemeral({ bearerToken: "secret", rateLimitPerMinute: 1 });
    handles.push(handle);

    const res = await rawRequest(handle.port, {
      method: "GET",
      path: "/health",
      host: "bad%zz",
      timeoutMs: 1_000,
    });

    expect(res.status).toBe(400);
    expect(res.body).toContain("Malformed request URL");
  });
});

// Send a raw HTTP/1.1 request so we can override the Host header (Node's
// global fetch silently rewrites Host from the URL).
interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawRequest(
  port: number,
  options: {
    method: string;
    path: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void): void => {
      clearTimeout(timeout);
      fn();
    };
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${port}`,
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(options.body).toString();
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          finish(() => resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }));
        });
      },
    );
    const timeout = setTimeout(() => {
      req.destroy(new Error("raw request timed out"));
    }, options.timeoutMs ?? 5_000);
    req.on("error", (err) => finish(() => reject(err)));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("regression: C1 — DNS rebinding protection actually rejects bad Host", () => {
  it("rejects a POST to /mcp whose Host header is not in the allowedHosts list", async () => {
    const token = "rebind-test-token";
    const handle = await startOnEphemeral({ bearerToken: token });
    handles.push(handle);

    // Valid initialize body with the right Content-Type and bearer; the
    // ONLY thing wrong is the Host header. Pre-fix, allowedHosts was the
    // empty array captured before listen() so the bad host was accepted
    // and the request would proceed to MCP handshake (200/4xx from SDK).
    // Post-fix the transport rejects with 403 from validateRequestHeaders.
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rebind-test", version: "0.0.0" },
      },
    });
    const res = await rawRequest(handle.port, {
      method: "POST",
      path: "/mcp",
      host: "attacker.example.com",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    // SDK returns 403 with a JSON-RPC error body.
    expect(res.status).toBe(403);
  });

  it("accepts a POST when Host matches the allowedHosts list (baseline)", async () => {
    const token = "rebind-test-token";
    const handle = await startOnEphemeral({ bearerToken: token });
    handles.push(handle);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rebind-test", version: "0.0.0" },
      },
    });
    const res = await rawRequest(handle.port, {
      method: "POST",
      path: "/mcp",
      host: `127.0.0.1:${handle.port}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    // The host is allowed, so the request reaches the MCP handshake.
    // We don't assert a specific code beyond "not the Host-rejected 403".
    expect(res.status).not.toBe(403);
  });
});

describe("regression: M1 — POST with non-JSON Content-Type returns 415", () => {
  it("rejects text/plain with 415 before buffering the body", async () => {
    const handle = await startOnEphemeral();
    handles.push(handle);

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json at all",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/application\/json/i);
  });

  it("rejects an empty Content-Type with 415", async () => {
    const handle = await startOnEphemeral();
    handles.push(handle);

    // Node fetch sets some default Content-Type for string bodies; use raw
    // http to fully omit the header.
    const res = await rawRequest(handle.port, {
      method: "POST",
      path: "/mcp",
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("still accepts application/json with charset suffix", async () => {
    const handle = await startOnEphemeral();
    handles.push(handle);
    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    // Whatever the MCP layer does next, it must NOT be a Content-Type 415.
    expect(res.status).not.toBe(415);
  });
});

describe("regression: M2 — /version gates non-GET methods when bearerToken is set", () => {
  it("POST /version with no auth returns 401 when bearerToken is set", async () => {
    const handle = await startOnEphemeral({ bearerToken: "secret", version: "1.2.3" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/version`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("POST /version succeeds (200) when no bearerToken is configured", async () => {
    const handle = await startOnEphemeral({ version: "9.9.9" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/version`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe("9.9.9");
  });

  it("POST /version with the correct bearer token returns 200", async () => {
    const handle = await startOnEphemeral({ bearerToken: "secret", version: "1.2.3" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/version`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("GET /version stays unauthenticated even when bearerToken is set (existing public-monitoring behavior)", async () => {
    const handle = await startOnEphemeral({ bearerToken: "secret", version: "1.2.3" });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/version`);
    expect(res.status).toBe(200);
  });
});

describe("regression: M5 — repeated startHttpServer does not leak signal listeners", () => {
  it("installSignalHandlers: true twice keeps SIGINT/SIGTERM at one listener each", async () => {
    // Capture the pre-test baseline so we don't depend on whatever the
    // vitest runner has already installed.
    const preSigint = process.listenerCount("SIGINT");
    const preSigterm = process.listenerCount("SIGTERM");

    const h1 = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      buildMcpServer: buildNoopServer,
      installSignalHandlers: true,
    });
    handles.push(h1);

    const h2 = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      buildMcpServer: buildNoopServer,
      installSignalHandlers: true,
    });
    handles.push(h2);

    // After two boots with installSignalHandlers: true, the listener count
    // for each signal must be exactly 1 (the second boot's handler) — NOT
    // pre + 2 (the pre-fix accumulation). We assert exactly 1 because the
    // fix unconditionally calls removeAllListeners, which wipes any
    // baseline too. That's fine for our CLI shutdown use case.
    expect(process.listenerCount("SIGINT")).toBe(preSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(preSigterm + 1);

    // Sanity: we definitely did not let the count exceed Node's default
    // max-listeners warning threshold (10).
    expect(process.listenerCount("SIGINT")).toBeLessThan(11);
    expect(process.listenerCount("SIGTERM")).toBeLessThan(11);

    // Note for future readers: `preSigint`/`preSigterm` are captured for
    // debugging if this ever regresses — they intentionally don't gate
    // the assertion so the test is deterministic regardless of harness.
    void preSigint;
    void preSigterm;
  });
});

describe("regression: HTTP Origin validation rejects browser DNS-rebinding attempts", () => {
  it("rejects a POST to /mcp from an Origin outside the allowlist", async () => {
    const token = "origin-test-token";
    const handle = await startOnEphemeral({ bearerToken: token });
    handles.push(handle);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "origin-test", version: "0.0.0" },
      },
    });
    const res = await rawRequest(handle.port, {
      method: "POST",
      path: "/mcp",
      host: `127.0.0.1:${handle.port}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        Origin: "https://attacker.example",
      },
      body,
    });

    expect(res.status).toBe(403);
    expect(res.body).toContain("Origin not allowed");
  });

  it("rejects preflight requests from an Origin outside the allowlist", async () => {
    const handle = await startOnEphemeral({ allowedOrigins: ["https://app.example"] });
    handles.push(handle);

    const res = await rawRequest(handle.port, {
      method: "OPTIONS",
      path: "/mcp",
      host: `127.0.0.1:${handle.port}`,
      headers: { Origin: "https://attacker.example" },
    });

    expect(res.status).toBe(403);
  });

  it("allows matching localhost Origins without requiring an explicit port", async () => {
    const handle = await startOnEphemeral();
    handles.push(handle);

    const res = await rawRequest(handle.port, {
      method: "OPTIONS",
      path: "/mcp",
      host: `127.0.0.1:${handle.port}`,
      headers: { Origin: "http://localhost" },
    });

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost");
  });
});

describe("regression: HTTP bearer token must not be empty", () => {
  it("rejects whitespace-only programmatic tokens", async () => {
    await expect(startOnEphemeral({ bearerToken: "   " })).rejects.toThrow(/token.*empty/i);
  });

  it("rejects non-loopback binds without bearer auth", async () => {
    let leaked: HttpServerHandle | undefined;
    let err: unknown;
    try {
      leaked = await startHttpServer({
        host: "0.0.0.0",
        port: 0,
        buildMcpServer: buildNoopServer,
        installSignalHandlers: false,
      });
    } catch (caught) {
      err = caught;
    } finally {
      if (leaked) await leaked.stop();
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/bearer token.*non-loopback/i);
  });

  it("allows non-loopback binds when bearer auth is configured", async () => {
    const handle = await startHttpServer({
      host: "0.0.0.0",
      port: 0,
      bearerToken: "secret",
      buildMcpServer: buildNoopServer,
      installSignalHandlers: false,
    });
    handles.push(handle);

    expect(handle.host).toBe("0.0.0.0");
  });
});
