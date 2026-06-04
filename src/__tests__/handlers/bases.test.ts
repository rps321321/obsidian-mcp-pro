import { describe, it, expect, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("base handlers — read_base", () => {
  it("escapes control characters in parsed display fields", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "dirty.base": [
          "properties:",
          "  \"bad\\tkey\":",
          "    displayName: \"Display\\nName\"",
          "views:",
          "  - type: \"table\\tview\"",
          "    name: \"Main\\nView\"",
          "",
        ].join("\n"),
      },
    });

    const result = await env.client.callTool({
      name: "read_base",
      arguments: { path: "dirty.base" },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("bad\\tkey");
    expect(text).toContain("Display\\nName");
    expect(text).toContain("Main\\nView");
    expect(text).toContain("table\\tview");
    expect(text).not.toContain("bad\tkey");
    expect(text).not.toContain("Display\nName");
    expect(text).not.toContain("Main\nView");
    expect(text).not.toContain("table\tview");
  });
});

describe("base handlers — query_base", () => {
  it("populates file.size/ctime/mtime for Base filters", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "note.md": "# Note\n\nBody",
        "stats.base": [
          "filters:",
          "  and:",
          "    - file.size > 0",
          "    - file.ctime > 0",
          "    - file.mtime > 0",
          "",
        ].join("\n"),
      },
    });

    const result = await env.client.callTool({
      name: "query_base",
      arguments: { path: "stats.base" },
    });

    expect(isError(result)).toBe(false);
    expect(textContent(result)).toContain("- note.md");
  });

  it("escapes control characters in view labels, warnings, and frontmatter keys", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "note.md": [
          "---",
          "\"bad\\tkey\": \"dirty\\nvalue\"",
          "---",
          "# Note",
          "",
        ].join("\n"),
        "query.base": [
          "views:",
          "  - type: table",
          "    name: clean",
          "",
        ].join("\n"),
      },
    });

    const result = await env.client.callTool({
      name: "query_base",
      arguments: {
        path: "query.base",
        view: "missing\nview",
        includeFrontmatter: true,
      },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("Base: query.base (view: missing\\nview)");
    expect(text).toContain('View not found: "missing\\nview";');
    expect(text).toContain('    bad\\tkey: "dirty\\nvalue"');
    expect(text).not.toContain("missing\nview");
    expect(text).not.toContain("bad\tkey");
    expect(text).not.toContain("dirty\nvalue");
  });
});
