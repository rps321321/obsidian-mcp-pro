import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("write handlers — create_note", () => {
  it("creates a note with body content", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: { path: "fresh.md", content: "Body of fresh note." },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/Created note at 'fresh\.md'/);

    const onDisk = await fs.readFile(path.join(env.vaultDir, "fresh.md"), "utf-8");
    expect(onDisk).toBe("Body of fresh note.");
  });

  it("parses a frontmatter JSON-string arg and renders YAML", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "with-fm.md",
        content: "Body.",
        frontmatter: JSON.stringify({ status: "draft", tags: ["idea"] }),
      },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "with-fm.md"), "utf-8");
    expect(onDisk).toMatch(/^---\n/);
    expect(onDisk).toMatch(/status: draft/);
    expect(onDisk).toMatch(/- idea/);
    expect(onDisk).toContain("Body.");
  });

  it("returns isError (not throws) on malformed frontmatter JSON", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "bad-fm.md",
        content: "x",
        frontmatter: "{ not valid JSON }",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/invalid JSON/i);
  });

  it("refuses to overwrite an existing note (EEXIST)", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: { path: "note-a.md", content: "overwritten?" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/already exists/i);

    // Original content preserved.
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-a.md"), "utf-8");
    expect(onDisk).toContain("Note A");
  });

  it("auto-appends .md when extension is missing", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: { path: "no-extension", content: "x" },
    });
    expect(isError(result)).toBe(false);
    // Response echoes the normalized path.
    expect(textContent(result)).toMatch(/no-extension\.md/);
    await expect(fs.access(path.join(env.vaultDir, "no-extension.md"))).resolves.toBeUndefined();
  });
});

describe("write handlers — append_to_note / prepend_to_note", () => {
  it("append adds a newline when the target doesn't end in one", async () => {
    const result = await env.client.callTool({
      name: "append_to_note",
      arguments: { path: "note-c.md", content: "APPENDED" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-c.md"), "utf-8");
    expect(onDisk).toMatch(/\nAPPENDED$/);
  });

  it("append returns isError for a missing file (not a silent create)", async () => {
    const result = await env.client.callTool({
      name: "append_to_note",
      arguments: { path: "no-such-file.md", content: "x" },
    });
    expect(isError(result)).toBe(true);
  });

  it("prepend preserves frontmatter and inserts after it", async () => {
    const result = await env.client.callTool({
      name: "prepend_to_note",
      arguments: { path: "note-a.md", content: "PREPENDED" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-a.md"), "utf-8");
    // Frontmatter block stays at the top, prepended content comes right after.
    const lines = onDisk.split("\n");
    const secondDelimiterIdx = lines.indexOf("---", 1);
    expect(secondDelimiterIdx).toBeGreaterThan(0);
    expect(lines.slice(secondDelimiterIdx + 1).join("\n")).toMatch(/^PREPENDED/);
  });

  it("prepend inserts at position 0 when the note has no frontmatter", async () => {
    const result = await env.client.callTool({
      name: "prepend_to_note",
      arguments: { path: "note-c.md", content: "HEADER" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-c.md"), "utf-8");
    expect(onDisk).toMatch(/^HEADER\n/);
  });
});

describe("write handlers — update_frontmatter", () => {
  it("merges new keys into an existing frontmatter block, preserving others", async () => {
    const result = await env.client.callTool({
      name: "update_frontmatter",
      arguments: {
        path: "note-a.md",
        properties: JSON.stringify({ priority: 1, status: "archived" }),
      },
    });
    expect(isError(result)).toBe(false);

    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-a.md"), "utf-8");
    expect(onDisk).toMatch(/priority: 1/);
    expect(onDisk).toMatch(/status: archived/);
    // Original `tags` array still present.
    expect(onDisk).toMatch(/- draft/);
    expect(onDisk).toMatch(/- review/);
  });

  it("creates a frontmatter block when the note had none", async () => {
    const result = await env.client.callTool({
      name: "update_frontmatter",
      arguments: {
        path: "note-c.md",
        properties: JSON.stringify({ category: "fresh" }),
      },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-c.md"), "utf-8");
    expect(onDisk).toMatch(/^---\n/);
    expect(onDisk).toMatch(/category: fresh/);
  });

  it("returns isError when properties arg isn't valid JSON", async () => {
    const result = await env.client.callTool({
      name: "update_frontmatter",
      arguments: { path: "note-a.md", properties: "definitely not json" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/invalid JSON/i);
  });
});

describe("write handlers — create_daily_note", () => {
  it("creates today's daily note at the configured folder/format", async () => {
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-01", content: "May 1 entry." },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/daily\/2026-05-01\.md/);

    const onDisk = await fs.readFile(path.join(env.vaultDir, "daily/2026-05-01.md"), "utf-8");
    expect(onDisk).toBe("May 1 entry.");
  });

  it("hydrates from a template and substitutes {{date}}", async () => {
    // Install a template file first.
    await fs.writeFile(
      path.join(env.vaultDir, "template.md"),
      "# Journal {{date}}\n\n- [ ] Ship something\n",
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-02", templatePath: "template.md" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "daily/2026-05-02.md"), "utf-8");
    expect(onDisk).toContain("# Journal 2026-05-02");
    expect(onDisk).toContain("[ ] Ship something");
  });

  it("refuses to overwrite an existing daily note", async () => {
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-04-24", content: "x" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/already exists/i);
  });
});

describe("write handlers — move_note", () => {
  it("moves a note and creates missing parent folders", async () => {
    const result = await env.client.callTool({
      name: "move_note",
      arguments: { oldPath: "note-c.md", newPath: "archive/2026/note-c.md" },
    });
    expect(isError(result)).toBe(false);

    await expect(fs.access(path.join(env.vaultDir, "archive/2026/note-c.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).rejects.toThrow();
  });

  it("refuses to overwrite an existing destination", async () => {
    const result = await env.client.callTool({
      name: "move_note",
      arguments: { oldPath: "note-a.md", newPath: "note-b.md" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/already exists/i);
  });

  it("rewrites references in referrers by default", async () => {
    // Fixture canvas references `note-a.md` via `nodes[].file`, which is a
    // structured path reference and must follow the move.
    const result = await env.client.callTool({
      name: "move_note",
      arguments: { oldPath: "note-a.md", newPath: "archive/2026/note-a.md" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/Updated references in \d+ file\(s\)/);

    const canvasRaw = await fs.readFile(
      path.join(env.vaultDir, "boards/test.canvas"),
      "utf-8",
    );
    const canvas = JSON.parse(canvasRaw);
    const fileNode = canvas.nodes.find((n: { type: string }) => n.type === "file");
    expect(fileNode.file).toBe("archive/2026/note-a.md");
  });

  it("updateLinks: false skips the rewrite pass", async () => {
    const result = await env.client.callTool({
      name: "move_note",
      arguments: {
        oldPath: "note-a.md",
        newPath: "archive/note-a.md",
        updateLinks: false,
      },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).not.toMatch(/Updated references/);

    // Canvas reference is left dangling — exactly the legacy behavior.
    const canvasRaw = await fs.readFile(
      path.join(env.vaultDir, "boards/test.canvas"),
      "utf-8",
    );
    const canvas = JSON.parse(canvasRaw);
    const fileNode = canvas.nodes.find((n: { type: string }) => n.type === "file");
    expect(fileNode.file).toBe("note-a.md");
  });
});

describe("write handlers — delete_note", () => {
  it("moves to .trash by default (reversible)", async () => {
    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "note-c.md" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/moved to trash/i);

    await expect(fs.access(path.join(env.vaultDir, ".trash/note-c.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).rejects.toThrow();
  });

  it("permanent=true unlinks without a trash stop", async () => {
    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "note-c.md", permanent: true },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/permanently deleted/i);

    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).rejects.toThrow();
    await expect(fs.access(path.join(env.vaultDir, ".trash/note-c.md"))).rejects.toThrow();
  });
});
