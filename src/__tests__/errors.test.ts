import { describe, it, expect } from "vitest";
import { sanitizeError, escapeControlChars, stripPaths } from "../lib/errors.js";

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

  it("strips quoted paths", () => {
    expect(stripPaths("ENOENT, open '/tmp/foo/bar.md'")).toBe("ENOENT, open <path>");
  });
});
