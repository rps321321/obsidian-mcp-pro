import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseArgs } from "../index.js";
import { runInstall } from "../install.js";

// Regression coverage for three audit findings:
//   - C7: --token <secret> / --token=<secret> leaks via process.argv (ps,
//         /proc/<pid>/cmdline).
//   - H2: install.ts serverName accepts control characters that corrupt the
//         JSON config or spoof terminal output via ANSI escapes.
//
// The M10 fix (daily resource throws on missing) is covered transitively by
// the existing SDK error-response contract — these tests focus on the CLI
// surface where direct argv/option mutation matters.

describe("parseArgs token redaction (C7)", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("should redact both argv slots when --token VALUE is passed as two arguments", () => {
    // Simulate `node script ... --token supersecret`.
    process.argv = ["node", "script", "--transport", "http", "--token", "supersecret"];
    const argv = process.argv.slice(2);

    const opts = parseArgs(argv);

    expect(opts.bearerToken).toBe("supersecret");
    // The local slice the caller passes in is redacted.
    expect(argv).not.toContain("supersecret");
    // And process.argv itself, which is what `ps` and /proc/<pid>/cmdline
    // expose, no longer contains the plaintext token.
    expect(process.argv).not.toContain("supersecret");
    expect(process.argv).toContain("***");
  });

  it("should redact the argv entry when --token=VALUE is passed as one argument", () => {
    process.argv = ["node", "script", "--token=secret"];
    const argv = process.argv.slice(2);

    const opts = parseArgs(argv);

    expect(opts.bearerToken).toBe("secret");
    expect(argv).not.toContain("--token=secret");
    expect(argv).toContain("--token=***");
    expect(process.argv).not.toContain("--token=secret");
    expect(process.argv).toContain("--token=***");
  });

  it("should still expose the captured token via the returned options", () => {
    // Redaction must not break the legitimate use of the token by the HTTP
    // server, only hide it from external observers.
    process.argv = ["node", "script", "--token", "abc123"];
    const opts = parseArgs(process.argv.slice(2));
    expect(opts.bearerToken).toBe("abc123");
  });

  it("should reject an empty inline token instead of silently disabling auth", () => {
    process.argv = ["node", "script", "--token="];
    expect(() => parseArgs(process.argv.slice(2))).toThrow(/token.*empty/i);
  });

  it("should reject a whitespace MCP_HTTP_TOKEN", () => {
    process.env.MCP_HTTP_TOKEN = "   ";
    try {
      expect(() => parseArgs([])).toThrow(/token.*empty/i);
    } finally {
      delete process.env.MCP_HTTP_TOKEN;
    }
  });

  it("should reject HTTP transport without a bearer token", () => {
    process.argv = ["node", "script", "--transport", "http"];
    expect(() => parseArgs(process.argv.slice(2))).toThrow(/bearer token is required/i);
  });

  it("should accept HTTP transport when MCP_HTTP_TOKEN is set", () => {
    process.env.MCP_HTTP_TOKEN = "env-token";
    try {
      process.argv = ["node", "script", "--transport", "http"];
      const opts = parseArgs(process.argv.slice(2));
      expect(opts.bearerToken).toBe("env-token");
    } finally {
      delete process.env.MCP_HTTP_TOKEN;
    }
  });
});

describe("runInstall serverName sanitization (H2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // runInstall writes to stdout before validation can fail; silence it so
    // the test output stays clean even when the assertion path runs first.
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("should throw when serverName contains a NUL byte", () => {
    expect(() =>
      runInstall({
        client: "claude",
        serverName: "obsidian\x00evil",
      }),
    ).toThrow(/control characters/i);
  });

  it("should throw when serverName contains an ANSI escape sequence", () => {
    // \x1b[31m is the ANSI "red" SGR code; if console.log prints serverName
    // verbatim, an attacker controlling the value could spoof terminal
    // output. The guard must reject it before any I/O happens.
    expect(() =>
      runInstall({
        client: "claude",
        serverName: "\x1b[31mfake-server\x1b[0m",
      }),
    ).toThrow(/control characters/i);
  });
});
