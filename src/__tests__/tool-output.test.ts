import { describe, expect, it } from "vitest";
import { formatFailedPath } from "../lib/tool-output.js";

describe("tool output helpers", () => {
  it("escapes control characters in failure paths and sanitizes errors", () => {
    const line = formatFailedPath(
      "notes/bad\nname.md",
      new Error("failed while reading /tmp/private-vault/secret.md"),
      "    ",
    );

    expect(line).toBe("    - notes/bad\\nname.md: failed while reading <path>");
  });
});
