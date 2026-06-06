import { describe, it, expect } from "vitest";
import {
  sanitizeError,
  escapeControlChars,
  stripPaths,
  redactUrlSecrets,
} from "../lib/errors.js";

describe("escapeControlChars", () => {
  it("passes printable ASCII through unchanged", () => {
    expect(escapeControlChars("hello world / path.md")).toBe("hello world / path.md");
  });

  it("escapes newline, carriage return, tab to backslash form", () => {
    expect(escapeControlChars("a\nb\rc\td")).toBe("a\\nb\\rc\\td");
  });

  it("escapes other control bytes to \\xHH", () => {
    expect(escapeControlChars("a\x00b\x01c\x1fd\x7fe")).toBe(
      "a\\x00b\\x01c\\x1fd\\x7fe",
    );
  });

  it("escapes Unicode bidi controls to \\uHHHH", () => {
    expect(escapeControlChars("safe\u202ecod.exe\u2066tail\u061c")).toBe(
      "safe\\u202ecod.exe\\u2066tail\\u061c",
    );
  });

  it("preserves non-ASCII characters (Unicode, accents)", () => {
    expect(escapeControlChars("résumé—café 你好")).toBe("résumé—café 你好");
  });
});

describe("sanitizeError", () => {
  it("collapses known errno codes to a generic message", () => {
    expect(sanitizeError({ code: "ENOENT", message: "ENOENT: no such file" })).toBe(
      "File or directory not found",
    );
  });

  it("strips absolute POSIX paths from the message", () => {
    expect(sanitizeError(new Error("failed to read /home/user/vault/note.md"))).toBe(
      "failed to read <path>",
    );
  });

  it("escapes control chars in the returned message", () => {
    // The injection vector: a stringified error message contains a newline
    // (e.g. an attacker-controlled filename was interpolated upstream). The
    // sanitized output must not contain a real newline that could break out
    // of its line in tool output.
    expect(sanitizeError("read failed: name\nIGNORE PREVIOUS")).toBe(
      "read failed: name\\nIGNORE PREVIOUS",
    );
  });

  it("escapes control chars in fallback Error.message path", () => {
    expect(sanitizeError(new Error("oops\r\nbad"))).toBe("oops\\r\\nbad");
  });

  it("escapes Unicode bidi controls in returned messages", () => {
    expect(sanitizeError("read failed: safe\u202ecod.exe")).toBe(
      "read failed: safe\\u202ecod.exe",
    );
  });

  it("redacts secret-bearing URLs in client-facing messages", () => {
    const msg = sanitizeError(
      "provider rejected https://alice:pa55@example.internal/v1?api_key=secret#debug",
    );
    expect(msg).toBe("provider rejected https://<redacted-url>");
    expect(msg).not.toContain("alice");
    expect(msg).not.toContain("pa55");
    expect(msg).not.toContain("api_key");
    expect(msg).not.toContain("example.internal");
  });

  it("returns a fixed string for non-Error input", () => {
    expect(sanitizeError(undefined)).toBe("Unknown error");
    expect(sanitizeError(null)).toBe("Unknown error");
    expect(sanitizeError(42)).toBe("Unknown error");
  });
});

describe("stripPaths", () => {
  it("strips Windows drive paths", () => {
    expect(stripPaths("can't open C:\\Users\\me\\note.md")).toBe(
      "can't open <path>",
    );
  });

  it("strips unquoted Windows drive paths containing spaces", () => {
    const text = stripPaths("can't open C:\\Users\\me\\My Vault\\secret.md");
    expect(text).toBe("can't open <path>");
    expect(text).not.toContain("My Vault");
    expect(text).not.toContain("secret.md");
  });

  it("strips unquoted POSIX file paths containing spaces", () => {
    const text = stripPaths("can't open /Users/me/My Vault/secret.md: permission denied");
    expect(text).toBe("can't open <path>: permission denied");
    expect(text).not.toContain("My Vault");
    expect(text).not.toContain("secret.md");
  });

  it("keeps diagnostic text after URL-path-like values", () => {
    expect(stripPaths("Ollama /api/embed returned HTTP 500")).toBe(
      "Ollama <path> returned HTTP 500",
    );
  });

  it("strips quoted paths", () => {
    expect(stripPaths("ENOENT, open '/tmp/foo/bar.md'")).toBe("ENOENT, open <path>");
  });

  it("strips double-quoted paths", () => {
    const text = stripPaths('ENOENT, open "/Users/me/My Vault/secret.md"');
    expect(text).toBe("ENOENT, open <path>");
    expect(text).not.toContain("My Vault");
    expect(text).not.toContain("secret.md");
  });
});

describe("redactUrlSecrets", () => {
  it("leaves plain diagnostic URLs unchanged", () => {
    expect(redactUrlSecrets("see https://api.example.com/v1")).toBe(
      "see https://api.example.com/v1",
    );
  });

  it("redacts URL credentials, query strings, and fragments", () => {
    const out = redactUrlSecrets(
      "bad ftp://user:pass@example.test/path?token=abc#frag.",
    );
    expect(out).toBe("bad ftp://<redacted-url>.");
    expect(out).not.toContain("user");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("token=abc");
    expect(out).not.toContain("example.test");
  });
});
