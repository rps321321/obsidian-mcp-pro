import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseArgs } from "../index.js";
import { runInstall } from "../install.js";

// Regression coverage for three audit findings:
//   - C7: --token <secret> / --token=<secret> leaks via process command-line
//         storage before runtime redaction can help, so HTTP auth uses
//         MCP_HTTP_TOKEN instead.
//   - H2: install.ts serverName accepts control characters that corrupt the
//         JSON config or spoof terminal output via ANSI escapes.
//
// The M10 fix (daily resource throws on missing) is covered transitively by
// the existing SDK error-response contract — these tests focus on the CLI
// surface where direct argv/option mutation matters.

describe("parseArgs HTTP token handling (C7)", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("should reject --token VALUE because command-line secrets can leak", () => {
    process.argv = ["node", "script", "--transport", "http", "--token", "supersecret"];
    expect(() => parseArgs(process.argv.slice(2))).toThrow(/MCP_HTTP_TOKEN/i);
  });

  it("should reject --token=VALUE because command-line secrets can leak", () => {
    process.argv = ["node", "script", "--token=secret"];
    expect(() => parseArgs(process.argv.slice(2))).toThrow(/MCP_HTTP_TOKEN/i);
  });

  it("should reject an empty inline token flag with the removed-flag message", () => {
    process.argv = ["node", "script", "--token="];
    expect(() => parseArgs(process.argv.slice(2))).toThrow(/removed.*MCP_HTTP_TOKEN/i);
  });

  it("should reject a whitespace MCP_HTTP_TOKEN", () => {
    process.env.MCP_HTTP_TOKEN = "   ";
    try {
      expect(() => parseArgs([])).toThrow(/MCP_HTTP_TOKEN cannot be empty/i);
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
