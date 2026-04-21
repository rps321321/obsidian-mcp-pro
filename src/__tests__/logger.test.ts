import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { log, configureLogger } from "../lib/logger.js";

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
  configureLogger({ level: "info", format: "text" });
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
});
