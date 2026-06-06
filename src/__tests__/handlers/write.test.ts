import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";
import { setMaxNoteFileBytesForTests } from "../../lib/vault.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  setMaxNoteFileBytesForTests(null);
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

  it("quotes wikilinks in created note frontmatter for Obsidian Properties", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "with-link-fm.md",
        content: "Body.",
        frontmatter: JSON.stringify({ related: "[[Note A]]" }),
      },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "with-link-fm.md"), "utf-8");
    expect(onDisk).toContain('related: "[[Note A]]"');
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

  it("escapes normalized paths in success and already-exists messages", async () => {
    const dirtyPath = "dirty\x7fnote.md";
    const created = await env.client.callTool({
      name: "create_note",
      arguments: { path: dirtyPath, content: "Control-char path." },
    });

    expect(isError(created)).toBe(false);
    expect(textContent(created)).toContain("dirty\\x7fnote.md");
    expect(textContent(created)).not.toContain(dirtyPath);
    await expect(fs.access(path.join(env.vaultDir, dirtyPath))).resolves.toBeUndefined();

    const duplicate = await env.client.callTool({
      name: "create_note",
      arguments: { path: dirtyPath, content: "Duplicate." },
    });
    expect(isError(duplicate)).toBe(true);
    expect(textContent(duplicate)).toContain("dirty\\x7fnote.md");
    expect(textContent(duplicate)).not.toContain(dirtyPath);
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

  it("refuses to append to oversized existing notes without changing bytes", async () => {
    setMaxNoteFileBytesForTests(10);
    const original = "private body";
    await fs.writeFile(path.join(env.vaultDir, "oversized.md"), original, "utf-8");

    const result = await env.client.callTool({
      name: "append_to_note",
      arguments: { path: "oversized.md", content: "tail" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(true);
    expect(text).toMatch(/note file exceeds size cap/i);
    expect(text).not.toContain(original);
    await expect(fs.readFile(path.join(env.vaultDir, "oversized.md"), "utf-8"))
      .resolves.toBe(original);
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

  it("escapes target paths in append, prepend, and frontmatter success messages", async () => {
    const dirtyPath = "mutate\x7fnote.md";
    await fs.writeFile(path.join(env.vaultDir, dirtyPath), "Body", "utf-8");

    const appended = await env.client.callTool({
      name: "append_to_note",
      arguments: { path: dirtyPath, content: "APPENDED" },
    });
    expect(isError(appended)).toBe(false);
    expect(textContent(appended)).toContain("mutate\\x7fnote.md");
    expect(textContent(appended)).not.toContain(dirtyPath);

    const prepended = await env.client.callTool({
      name: "prepend_to_note",
      arguments: { path: dirtyPath, content: "PREPENDED" },
    });
    expect(isError(prepended)).toBe(false);
    expect(textContent(prepended)).toContain("mutate\\x7fnote.md");
    expect(textContent(prepended)).not.toContain(dirtyPath);

    const updated = await env.client.callTool({
      name: "update_frontmatter",
      arguments: { path: dirtyPath, properties: JSON.stringify({ status: "dirty" }) },
    });
    expect(isError(updated)).toBe(false);
    expect(textContent(updated)).toContain("mutate\\x7fnote.md");
    expect(textContent(updated)).not.toContain(dirtyPath);
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

  it("rejects calendar-impossible dates instead of normalizing them", async () => {
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-02-31", content: "x" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/Invalid date/);
  });

  it("escapes configured daily-note paths in create output", async () => {
    const dirtyFolder = "daily\x7fnotes";
    await fs.writeFile(
      path.join(env.vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: dirtyFolder, format: "YYYY-MM-DD" }),
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-07", content: "May 7 entry." },
    });

    expect(isError(result)).toBe(false);
    expect(textContent(result)).toContain("daily\\x7fnotes/2026-05-07.md");
    expect(textContent(result)).not.toContain(`${dirtyFolder}/2026-05-07.md`);
    await expect(
      fs.access(path.join(env.vaultDir, dirtyFolder, "2026-05-07.md")),
    ).resolves.toBeUndefined();
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

  it("cancels a link-rewriting move when elicitation is cancelled", async () => {
    await env.cleanup();
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: () => ({ action: "cancel" }),
    });

    const result = await env.client.callTool({
      name: "move_note",
      arguments: { oldPath: "note-c.md", newPath: "archive/note-c.md" },
    });

    expect(isError(result)).toBe(false);
    expect(textContent(result)).toContain('Move of "note-c.md" cancelled.');
    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(env.vaultDir, "archive/note-c.md"))).rejects.toThrow();
  });

  it("moves after elicitation confirms the destination path", async () => {
    await env.cleanup();
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: (request) => {
        expect(request.params.message).toContain("update references across the vault");
        return {
          action: "accept",
          content: { confirmPath: "archive/note-c.md" },
        };
      },
    });

    const result = await env.client.callTool({
      name: "move_note",
      arguments: { oldPath: "note-c.md", newPath: "archive/note-c.md" },
    });

    expect(isError(result)).toBe(false);
    await expect(fs.access(path.join(env.vaultDir, "archive/note-c.md"))).resolves.toBeUndefined();
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

  it("escapes source and destination paths in move output", async () => {
    const oldPath = "move\x7fold.md";
    const newPath = "archive/move\x7fnew.md";
    await fs.writeFile(path.join(env.vaultDir, oldPath), "Move me.", "utf-8");

    const result = await env.client.callTool({
      name: "move_note",
      arguments: { oldPath, newPath, updateLinks: false },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("move\\x7fold.md");
    expect(text).toContain("archive/move\\x7fnew.md");
    expect(text).not.toContain(oldPath);
    expect(text).not.toContain(newPath);
    await expect(fs.access(path.join(env.vaultDir, newPath))).resolves.toBeUndefined();
  });

  it("marks failed referrer paths in move warnings as untrusted", async () => {
    const dirtyPath = "dirty\x7fref.md";
    await fs.writeFile(path.join(env.vaultDir, dirtyPath), "See [[note-a]].", "utf-8");

    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockImplementationOnce(
      async (...args: Parameters<typeof fs.link>) => {
        await realLink(...args);
        await fs.writeFile(path.join(env.vaultDir, dirtyPath), "See [[other-note]].", "utf-8");
      },
    );

    const result = await (async () => {
      try {
        return await env.client.callTool({
          name: "move_note",
          arguments: { oldPath: "note-a.md", newPath: "archive/renamed-a.md" },
        });
      } finally {
        linkSpy.mockRestore();
      }
    })();

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(isError(result)).toBe(false);
    expect(text).toContain("Warning: 1 file(s) could not be updated:");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: move_note failed referrer]");
    expect(text).toContain("dirty\\x7fref.md: content changed during move; references not updated");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: move_note failed referrer: dirty\\x7fref.md]");
    expect(text).not.toContain(dirtyPath);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe("move_note failed referrers");
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
      arguments: { path: "note-c.md", permanent: true, confirm: true },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/permanently deleted/i);

    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).rejects.toThrow();
    await expect(fs.access(path.join(env.vaultDir, ".trash/note-c.md"))).rejects.toThrow();
  });

  it("escapes note paths in trash-delete output", async () => {
    const dirtyPath = "delete\x7fnote.md";
    await fs.writeFile(path.join(env.vaultDir, dirtyPath), "Delete me.", "utf-8");

    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: dirtyPath },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("delete\\x7fnote.md");
    expect(text).not.toContain(dirtyPath);
    await expect(fs.access(path.join(env.vaultDir, ".trash", dirtyPath))).resolves.toBeUndefined();
  });

  it("escapes note paths before permanent-delete confirmation", async () => {
    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "line\nbreak", permanent: true },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(true);
    expect(text).toContain('Permanent deletion of "line\\nbreak.md" requires confirm=true');
    expect(text).not.toContain("line\nbreak.md");
  });

  it("marks failed referrer paths in permanent-delete warnings as untrusted", async () => {
    const dirtyPath = "dirty\x7fdelete-ref.md";
    await fs.writeFile(path.join(env.vaultDir, dirtyPath), "See [[note-a]].", "utf-8");

    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementationOnce(
      async (...args: Parameters<typeof fs.unlink>) => {
        await realUnlink(...args);
        await fs.writeFile(path.join(env.vaultDir, dirtyPath), "See [[other-note]].", "utf-8");
      },
    );

    const result = await (async () => {
      try {
        return await env.client.callTool({
          name: "delete_note",
          arguments: {
            path: "note-a.md",
            permanent: true,
            confirm: true,
            removeReferences: true,
          },
        });
      } finally {
        unlinkSpy.mockRestore();
      }
    })();

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(isError(result)).toBe(false);
    expect(text).toContain("Warning: 1 file(s) could not be updated:");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: delete_note failed referrer]");
    expect(text).toContain("dirty\\x7fdelete-ref.md: content changed during move; references not updated");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: delete_note failed referrer: dirty\\x7fdelete-ref.md]");
    expect(text).not.toContain(dirtyPath);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe("delete_note failed referrers");
  });
});
