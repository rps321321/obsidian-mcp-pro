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
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  // Reset to defaults so one test's override doesn't leak into the next.
  configureLogger({ level: "info", format: "text", mcpServer: null });
});

describe("logger", () => {
  it("filters messages below the configured level", () => {
    configureLogger({ level: "warn" });
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

  it("strips absolute paths from forwarded MCP payload but keeps them in stderr", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "text", mcpServer: fakeServer });

    log.info("vault configured", { vault: "/Users/alice/Documents/MyVault", configPath: "C:\\Users\\bob\\.obsidian" });

    // Local stderr keeps the full path for operator diagnostics.
    const stderrOut = captured.join("");
    expect(stderrOut).toContain("/Users/alice/Documents/MyVault");
    expect(stderrOut).toContain("C:\\Users\\bob");

    // MCP-forwarded payload MUST NOT contain the absolute host paths.
    expect(sendLoggingMessage).toHaveBeenCalledTimes(1);
    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).not.toContain("alice");
    expect(dataStr).not.toContain("bob");
    expect(dataStr).toContain("<path>");
  });

  it("strips paths recursively from nested objects (e.g. serialized errors)", () => {
    const sendLoggingMessage = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { server: { sendLoggingMessage } } as unknown as McpServer;
    configureLogger({ level: "info", format: "json", mcpServer: fakeServer });

    const err = new Error("ENOENT: no such file '/Users/alice/vault/secret.md'");
    log.error("tool failed", { err });

    const [params] = sendLoggingMessage.mock.calls[0];
    const dataStr = JSON.stringify(params.data);
    expect(dataStr).not.toContain("alice");
    expect(dataStr).not.toContain("secret.md");
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
