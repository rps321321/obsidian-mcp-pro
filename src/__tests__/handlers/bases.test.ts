import { describe, it, expect, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";
import { MAX_BASE_FILE_BYTES } from "../../lib/bases.js";

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("base handlers — read_base", () => {
  it("rejects oversized Base files before parsing", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "huge.base": "x".repeat(MAX_BASE_FILE_BYTES + 1),
      },
    });

    const result = await env.client.callTool({
      name: "read_base",
      arguments: { path: "huge.base" },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/base file exceeds size cap/i);
  });

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
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const text = textContent(result);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: base: dirty.base]");
    expect(text).toContain("bad\\tkey");
    expect(text).toContain("Display\\nName");
    expect(text).toContain("Main\\nView");
    expect(text).toContain("table\\tview");
    expect(text).not.toContain("bad\tkey");
    expect(text).not.toContain("Display\nName");
    expect(text).not.toContain("Main\nView");
    expect(text).not.toContain("table\tview");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });
});

describe("base handlers - list_bases", () => {
  it("marks listed Base paths as untrusted", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "boards/roadmap.base": "",
        "tasks.base": "",
      },
    });

    const result = await env.client.callTool({
      name: "list_bases",
      arguments: {},
    });

    expect(isError(result)).toBe(false);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const text = textContent(result);
    expect(text).toContain("Found 2 Base file(s):");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: list_bases paths]");
    expect(text).toContain("boards/roadmap.base");
    expect(text).toContain("tasks.base");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });
});

describe("base handlers — query_base", () => {
  it("rejects oversized Base files without returning readable rows", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "note.md": [
          "---",
          "secret: readable",
          "---",
          "# Note",
          "",
        ].join("\n"),
        "huge.base": "x".repeat(MAX_BASE_FILE_BYTES + 1),
      },
    });

    const result = await env.client.callTool({
      name: "query_base",
      arguments: { path: "huge.base", includeFrontmatter: true },
    });

    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toMatch(/base file exceeds size cap/i);
    expect(text).not.toContain("- note.md");
    expect(text).not.toContain("secret");
  });

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
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const text = textContent(result);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: query_base base path]");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: query_base result paths]");
    expect(text).toContain("- note.md");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("escapes control characters in view labels and frontmatter keys", async () => {
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
          "    name: \"dirty\\nview\"",
          "",
        ].join("\n"),
      },
    });

    const result = await env.client.callTool({
      name: "query_base",
      arguments: {
        path: "query.base",
        view: "dirty\nview",
        includeFrontmatter: true,
      },
    });

    expect(isError(result)).toBe(false);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const text = textContent(result);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: query_base base path]");
    expect(text).toContain("query.base");
    expect(text).toContain("View: dirty\\nview");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: query_base row path: note.md]");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: base row frontmatter: note.md]");
    expect(text).toContain('    bad\\tkey: "dirty\\nvalue"');
    expect(text).not.toContain("dirty\nview");
    expect(text).not.toContain("bad\tkey");
    expect(text).not.toContain("dirty\nvalue");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("fails closed for missing views instead of returning base-level rows", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "note.md": [
          "---",
          "secret: readable",
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
    expect(text).toContain("Matched 0 note(s)");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: query_base warnings]");
    expect(text).toContain('View not found: "missing\\nview"; treating query as no-match.');
    expect(text).not.toContain("- note.md");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("missing\nview");
  });

  it("fails closed for unsupported filters instead of returning readable rows", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "public.md": [
          "---",
          "secret: readable",
          "---",
          "# Public",
          "",
        ].join("\n"),
        "query.base": [
          "filters:",
          "  - mysteryFn(\"status\")",
          "",
        ].join("\n"),
      },
    });

    const result = await env.client.callTool({
      name: "query_base",
      arguments: {
        path: "query.base",
        includeFrontmatter: true,
      },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("Matched 0 note(s)");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: query_base warnings]");
    expect(text).toContain("Unknown filter function: mysteryFn");
    expect(text).not.toContain("- public.md");
    expect(text).not.toContain("secret");
  });
});
