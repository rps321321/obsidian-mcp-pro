import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { log, configureLogger } from "../lib/logger.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The logger writes directly to process.stderr — monkeypatch `write` to
// capture output without globals leaking across tests.
let captured: string[];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  captured = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  });
});

afterEach(() => {
  process.stderr.write = originalWrite;
  // Reset to defaults so one test's override doesn't leak into the next.
  configureLogger({ level: "info", format: "text", mcpServer: null });
});

describe("logger", () => {
  it("filters messages below the configured level", () => {
    configureLogger({ level: "warn", format: "text" });
    log.debug("nope");
    log.info("also nope");
    log.warn("yes");
    log.error("yes");
    const joined = captured.join("");
    expect(joined).not.toContain("nope");
    expect(joined).toContain("warn yes");
    expect(joined).toContain("error yes");
  });

  it("emits structured JSON in json mode with serialized errors", () => {
    configureLogger({ level: "info", format: "json" });
    log.error("boom", { err: new Error("root cause"), retries: 3 });
    const line = captured.join("");
    const parsed = JSON.parse(line.trim()) as {
      level: string;
      msg: string;
      retries: number;
      err: { message: string; stack?: string };
    };
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("boom");
    expect(parsed.retries).toBe(3);
    expect(parsed.err.message).toBe("root cause");
    expect(parsed.err.stack).toBeDefined();
  });

  it("silent level suppresses all output", () => {
    configureLogger({ level: "silent" });
    log.error("should not appear");
    expect(captured.join("")).toBe("");
  });

  it("formats text-mode fields as key=value pairs", () => {
    configureLogger({ level: "info", format: "text" });
    log.info("startup", { port: 3333, host: "127.0.0.1" });
    const out = captured.join("");
    expect(out).toContain("info startup");
    expect(out).toContain("port=3333");
    expect(out).toContain("host=127.0.0.1");
  });

  it("forwards to MCP when a server is configured, mapping warn→warning", async () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    // Minimal shape the logger touches: `server.server.sendLoggingMessage`.
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.warn("low disk", { usagePct: 92 });
    // Fire-and-forget — let the rejected/resolved microtask drain.
    await Promise.resolve();

    expect(sendLoggingMessage).toHaveBeenCalledTimes(1);
    const [params] = sendLoggingMessage.mock.calls[0];
    expect(params.level).toBe("warning");
    expect(params.logger).toBe("obsidian-mcp-pro");
    expect(params.data).toMatchObject({ msg: "low disk", usagePct: 92 });
  });

  it("does not forward messages filtered by local level", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "warn", format: "text", mcpServer: fakeServer });

    log.debug("ignored");
    log.info("also ignored");
    expect(sendLoggingMessage).not.toHaveBeenCalled();
  });

  it("strips absolute paths from stderr and forwarded MCP payloads", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.info("vault configured", { vault: "/Users/alice/Documents/MyVault", configPath: "C:\\Users\\bob\\.obsidian" });

    const stderrOut = captured.join("");
    expect(stderrOut).not.toContain("/Users/alice/Documents/MyVault");
    expect(stderrOut).not.toContain("C:\\Users\\bob");
    expect(stderrOut).toContain("<path>");

    expect(sendLoggingMessage).toHaveBeenCalledTimes(1);
    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).not.toContain("alice");
    expect(dataStr).not.toContain("bob");
    expect(dataStr).toContain("<path>");
  });

  it("redacts vault-relative path fields from forwarded MCP payload", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.warn("search_notes: note read failed", {
      note: "private/therapy.md",
      relPath: "finance/taxes-2026.md",
      notes: ["daily.md"],
      nested: { path: "projects/acquisition.md" },
    });

    const stderrOut = captured.join("");
    expect(stderrOut).not.toContain("private/therapy.md");
    expect(stderrOut).not.toContain("finance/taxes-2026.md");
    expect(stderrOut).not.toContain("daily.md");
    expect(stderrOut).not.toContain("projects/acquisition.md");
    expect(stderrOut).toContain("<vault path>");

    expect(sendLoggingMessage).toHaveBeenCalledTimes(1);
    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).not.toContain("therapy");
    expect(dataStr).not.toContain("taxes");
    expect(dataStr).not.toContain("daily.md");
    expect(dataStr).not.toContain("acquisition");
    expect(dataStr).toContain("<vault path>");
  });

  it("keeps non-path diagnostics under path-like field names", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.info("retry scheduled", {
      note: "retrying after transient error",
      file: "index.ts",
      nested: { path: "transport label" },
    });

    const [params] = sendLoggingMessage.mock.calls[0];
    expect(params.data).toMatchObject({
      note: "retrying after transient error",
      file: "index.ts",
      nested: { path: "transport label" },
    });
  });

  it("redacts path-like values under compound path field names", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.warn("rewrite plan failed", {
      sourcePath: "private/source.md",
      target_path: "archive/target.canvas",
      profile: "daily.md",
      origin: "https://example.test/path",
    });

    expect(sendLoggingMessage).toHaveBeenCalledTimes(1);
    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).not.toContain("private/source.md");
    expect(dataStr).not.toContain("archive/target.canvas");
    expect(dataStr).toContain("<vault path>");
    expect(params.data).toMatchObject({
      profile: "daily.md",
      origin: "https://example.test/path",
    });
  });

  it("strips paths recursively from nested objects (e.g. serialized errors)", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "json", mcpServer: fakeServer });

    const err = new Error("ENOENT: no such file '/Users/alice/vault/secret.md'");
    log.error("tool failed", { err });
    log.error("tool failed", { err: new Error("Note not found: private/therapy.md") });

    const dataStr = JSON.stringify(sendLoggingMessage.mock.calls.map(([params]) => params.data));
    expect(dataStr).not.toContain("alice");
    expect(dataStr).not.toContain("secret.md");
    expect(dataStr).not.toContain("therapy");
    expect(dataStr).toContain("<vault path>");

    const stderrOut = captured.join("");
    expect(stderrOut).not.toContain("alice");
    expect(stderrOut).not.toContain("secret.md");
    expect(stderrOut).not.toContain("therapy");
    expect(stderrOut).toContain("<vault path>");
  });

  it("redacts local JSON logs before writing to stderr", () => {
    configureLogger({ level: "info", format: "json" });

    log.error("provider rejected https://alice:pa55@example.internal/v1?token=abc\nnext", {
      vault: "/Users/alice/Documents/MyVault",
      note: "private/therapy.md",
      err: new Error("Note not found: private/therapy.md"),
    });

    const parsed = JSON.parse(captured.join("").trim()) as {
      msg: string;
      vault: string;
      note: string;
      err: { message: string; stack?: string };
    };
    const serialized = JSON.stringify(parsed);
    expect(parsed.msg).toBe("provider rejected https://<redacted-url>\\nnext");
    expect(parsed.vault).toBe("<path>");
    expect(parsed.note).toBe("<vault path>");
    expect(parsed.err.message).toContain("<vault path>");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("therapy");
    expect(serialized).not.toContain("pa55");
    expect(serialized).not.toContain("\nnext");
  });

  it("keeps non-path slashes in serialized error diagnostics", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "json", mcpServer: fakeServer });

    log.error("provider failed", {
      err: new Error(
        "OBSIDIAN_EMBEDDING_URL scheme/host not allowed. Only https:// URLs and http:// to localhost/127.0.0.1 are permitted.",
      ),
    });

    const stderrOut = captured.join("");
    expect(stderrOut).toContain("scheme/host");
    expect(stderrOut).toContain("https:// URLs");
    expect(stderrOut).toContain("localhost/127.0.0.1");

    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).toContain("scheme/host");
    expect(dataStr).toContain("https:// URLs");
    expect(dataStr).toContain("localhost/127.0.0.1");
  });

  it("escapes controls recursively in forwarded MCP payloads", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.warn("line\nbreak", {
      detail: "name\r\nIGNORE PREVIOUS",
      nested: { label: "safe\u202ecod.exe" },
      err: new Error("boom\nnext"),
    });

    const [params] = sendLoggingMessage.mock.calls[0];
    expect(params.data.msg).toBe("line\\nbreak");
    expect(params.data.detail).toBe("name\\r\\nIGNORE PREVIOUS");
    expect(params.data.nested).toMatchObject({ label: "safe\\u202ecod.exe" });
    expect(params.data.err.message).toBe("boom\\nnext");
    expect(params.data.err.stack).not.toContain("\n");
    expect(params.data.err.stack).toContain("\\n");
  });

  it("redacts secret-bearing URLs from forwarded MCP payloads", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.warn("provider rejected https://alice:pa55@example.internal/v1?token=abc#debug", {
      endpoint: "https://api.example.internal/v1?api_key=secret",
      plainUrl: "https://status.example.test/health",
      nested: { callback: "https://callback.example.test/path?sig=hidden" },
      err: new Error("bad https://bob:pw@host.test/path#frag"),
    });

    const stderrOut = captured.join("");
    expect(stderrOut).not.toContain("alice");
    expect(stderrOut).not.toContain("pa55");
    expect(stderrOut).not.toContain("api_key");
    expect(stderrOut).not.toContain("bob");
    expect(stderrOut).not.toContain("host.test");
    expect(stderrOut).not.toContain("sig=hidden");
    expect(stderrOut).toContain("https://<redacted-url>");

    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).not.toContain("alice");
    expect(dataStr).not.toContain("pa55");
    expect(dataStr).not.toContain("api_key");
    expect(dataStr).not.toContain("bob");
    expect(dataStr).not.toContain("host.test");
    expect(dataStr).not.toContain("sig=hidden");
    expect(dataStr).toContain("https://<redacted-url>");
    expect(params.data.plainUrl).toBe("https://status.example.test/health");
  });

  it("swallows sendLoggingMessage rejections (logging must never fail a call)", async () => {
    const sendLoggingMessage = vi.fn().mockRejectedValue(new Error("not connected"));
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    expect(() => log.info("startup")).not.toThrow();
    // Drain the rejected promise so the unhandled-rejection detector doesn't trip.
    await new Promise((r) => setImmediate(r));
    expect(sendLoggingMessage).toHaveBeenCalled();
  });
});
