import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  resolveVaultPath,
  listNotes,
  readNote,
  writeNote,
  appendToNote,
  prependToNote,
  deleteNote,
  moveNote,
  searchNotes,
  readCanvasFile,
  writeCanvasFile,
} from "../lib/vault.js";
import {
  extractTags,
  extractWikilinks,
  resolveWikilink,
} from "../lib/markdown.js";
import type { CanvasData } from "../types.js";

// ---------------------------------------------------------------------------
// Test vault setup
// ---------------------------------------------------------------------------

let vaultPath: string;

const NOTE_A_CONTENT = `---
title: Note A
tags:
  - project
  - alpha
---

# Note A

This is a test note with a link to [[note-b]].

Some content about testing and #inline-tag here.
`;

const NOTE_B_CONTENT = `---
title: Note B
tags:
  - project
  - beta
---

# Note B

This links to [[note-c|Note C display text]].

More content for searching the word test.
`;

const NOTE_C_CONTENT = `---
title: Note C
---

# Note C

This note has no outgoing wikilinks. It is an orphan for outlinks.
`;

const NESTED_NOTE_CONTENT = `---
title: Nested Note
tags:
  - nested
---

# Nested Note

A note inside a folder with #deep-tag.
`;

const DAILY_NOTE_CONTENT = `---
title: Daily 2026-03-22
---

# Daily Note

Tasks for today.
`;

const TEST_CANVAS: CanvasData = {
  nodes: [
    {
      id: "node-1",
      type: "text",
      x: 0,
      y: 0,
      width: 250,
      height: 60,
      text: "First node",
    },
    {
      id: "node-2",
      type: "text",
      x: 300,
      y: 0,
      width: 250,
      height: 60,
      text: "Second node",
    },
  ],
  edges: [
    {
      id: "edge-1",
      fromNode: "node-1",
      toNode: "node-2",
      label: "connects",
    },
  ],
};

async function createTestVault(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-test-"));

  // Create .obsidian directory (marks it as a vault)
  await fs.mkdir(path.join(tmpDir, ".obsidian"), { recursive: true });

  // Root-level notes
  await fs.writeFile(path.join(tmpDir, "note-a.md"), NOTE_A_CONTENT, "utf-8");
  await fs.writeFile(path.join(tmpDir, "note-b.md"), NOTE_B_CONTENT, "utf-8");
  await fs.writeFile(path.join(tmpDir, "note-c.md"), NOTE_C_CONTENT, "utf-8");

  // Nested note
  await fs.mkdir(path.join(tmpDir, "folder"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "folder", "nested-note.md"),
    NESTED_NOTE_CONTENT,
    "utf-8",
  );

  // Daily note
  await fs.mkdir(path.join(tmpDir, "daily"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "daily", "2026-03-22.md"),
    DAILY_NOTE_CONTENT,
    "utf-8",
  );

  // Canvas file
  await fs.writeFile(
    path.join(tmpDir, "test.canvas"),
    JSON.stringify(TEST_CANVAS, null, 2),
    "utf-8",
  );

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  vaultPath = await createTestVault();
});

afterAll(async () => {
  await fs.rm(vaultPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Read Tools
// ---------------------------------------------------------------------------

describe("Read Tools", () => {
  it("searchNotes should find notes containing 'test'", async () => {
    const results = await searchNotes(vaultPath, "test");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const paths = results.map((r) => r.relativePath);
    expect(paths).toContain("note-a.md");
  });

  it("readNote should return correct content for note-a.md", async () => {
    const content = await readNote(vaultPath, "note-a.md");
    expect(content).toBe(NOTE_A_CONTENT);
  });

  it("readNote should throw for non-existent note", async () => {
    await expect(readNote(vaultPath, "does-not-exist.md")).rejects.toThrow(
      "Note not found",
    );
  });

  it("listNotes should list all 5 markdown notes", async () => {
    const notes = await listNotes(vaultPath);
    expect(notes).toHaveLength(5);
    expect(notes).toContain("note-a.md");
    expect(notes).toContain("note-b.md");
    expect(notes).toContain("note-c.md");
    expect(notes).toContain("folder/nested-note.md");
    expect(notes).toContain("daily/2026-03-22.md");
  });

  it("listNotes should respect folder filter", async () => {
    const notes = await listNotes(vaultPath, "folder");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe("folder/nested-note.md");
  });

  it("listNotes should return empty array for non-existent folder", async () => {
    const notes = await listNotes(vaultPath, "nonexistent");
    expect(notes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Write Tools
// ---------------------------------------------------------------------------

describe("Write Tools", () => {
  it("writeNote + readNote roundtrip", async () => {
    const content = "# New Note\n\nCreated by test.\n";
    await writeNote(vaultPath, "write-test.md", content);
    const read = await readNote(vaultPath, "write-test.md");
    expect(read).toBe(content);

    // cleanup
    await fs.unlink(path.join(vaultPath, "write-test.md"));
  });

  it("appendToNote should append without double newlines", async () => {
    // note-a ends with a newline, so separator should be empty
    const appendContent = "Appended line.";
    await appendToNote(vaultPath, "note-a.md", appendContent);
    const updated = await readNote(vaultPath, "note-a.md");

    expect(updated).toContain(appendContent);
    // Should not have double newlines before the appended content
    expect(updated).not.toContain("\n\n\nAppended line.");

    // Restore original content
    await writeNote(vaultPath, "note-a.md", NOTE_A_CONTENT);
  });

  it("prependToNote should insert after frontmatter", async () => {
    const prependContent = "Prepended paragraph.";
    await prependToNote(vaultPath, "note-a.md", prependContent);
    const updated = await readNote(vaultPath, "note-a.md");

    // Frontmatter should still be at the top
    expect(updated.startsWith("---")).toBe(true);

    // The prepended content should appear after the closing ---
    const afterFrontmatter = updated.split("---").slice(2).join("---");
    expect(afterFrontmatter).toContain(prependContent);

    // The prepended content should appear before the original body
    const prependIdx = updated.indexOf(prependContent);
    const bodyIdx = updated.indexOf("# Note A");
    expect(prependIdx).toBeLessThan(bodyIdx);

    // Restore original
    await writeNote(vaultPath, "note-a.md", NOTE_A_CONTENT);
  });

  it("deleteNote should move file to .trash", async () => {
    // Create a throwaway note
    await writeNote(vaultPath, "to-delete.md", "Delete me.");
    await deleteNote(vaultPath, "to-delete.md", true);

    // Original should be gone
    await expect(
      fs.access(path.join(vaultPath, "to-delete.md")),
    ).rejects.toThrow();

    // Should be in .trash
    const trashContent = await fs.readFile(
      path.join(vaultPath, ".trash", "to-delete.md"),
      "utf-8",
    );
    expect(trashContent).toBe("Delete me.");

    // cleanup trash
    await fs.rm(path.join(vaultPath, ".trash"), { recursive: true, force: true });
  });

  it("moveNote should move file and remove old path", async () => {
    await writeNote(vaultPath, "move-source.md", "Move me.");
    await moveNote(vaultPath, "move-source.md", "moved/move-target.md");

    // Old path gone
    await expect(
      fs.access(path.join(vaultPath, "move-source.md")),
    ).rejects.toThrow();

    // New path exists with same content
    const content = await readNote(vaultPath, "moved/move-target.md");
    expect(content).toBe("Move me.");

    // cleanup
    await fs.rm(path.join(vaultPath, "moved"), { recursive: true, force: true });
  });

  it("moveNote should reject if destination already exists", async () => {
    await expect(
      moveNote(vaultPath, "note-a.md", "note-b.md"),
    ).rejects.toThrow("Destination already exists");
  });
});

// ---------------------------------------------------------------------------
// Tag Operations
// ---------------------------------------------------------------------------

describe("Tag Operations", () => {
  it("should extract frontmatter tags from note-a", () => {
    const tags = extractTags(NOTE_A_CONTENT);
    expect(tags).toContain("project");
    expect(tags).toContain("alpha");
  });

  it("should extract inline tags from note-a", () => {
    const tags = extractTags(NOTE_A_CONTENT);
    expect(tags).toContain("inline-tag");
  });

  it("should extract both frontmatter and inline tags together", () => {
    const tags = extractTags(NOTE_A_CONTENT);
    // Frontmatter: project, alpha. Inline: inline-tag
    expect(tags.length).toBeGreaterThanOrEqual(3);
  });

  it("should extract tags from nested note", () => {
    const tags = extractTags(NESTED_NOTE_CONTENT);
    expect(tags).toContain("nested");
    expect(tags).toContain("deep-tag");
  });
});

// ---------------------------------------------------------------------------
// Link Operations
// ---------------------------------------------------------------------------

describe("Link Operations", () => {
  const allNotes = [
    "note-a.md",
    "note-b.md",
    "note-c.md",
    "folder/nested-note.md",
    "daily/2026-03-22.md",
  ];

  it("extractWikilinks on note-a should find link to note-b", () => {
    const links = extractWikilinks(NOTE_A_CONTENT);
    const targets = links.map((l) => l.target);
    expect(targets).toContain("note-b");
  });

  it("extractWikilinks on note-b should find link to note-c with display text", () => {
    const links = extractWikilinks(NOTE_B_CONTENT);
    const noteCLink = links.find((l) => l.target === "note-c");
    expect(noteCLink).toBeDefined();
    expect(noteCLink!.displayText).toBe("Note C display text");
    expect(noteCLink!.isEmbed).toBe(false);
  });

  it("extractWikilinks on note-c should find no links", () => {
    const links = extractWikilinks(NOTE_C_CONTENT);
    expect(links).toHaveLength(0);
  });

  it("resolveWikilink should resolve 'note-b' to 'note-b.md'", () => {
    const resolved = resolveWikilink("note-b", "note-a.md", allNotes);
    expect(resolved).toBe("note-b.md");
  });

  it("resolveWikilink should resolve 'note-c' to 'note-c.md'", () => {
    const resolved = resolveWikilink("note-c", "note-b.md", allNotes);
    expect(resolved).toBe("note-c.md");
  });

  it("resolveWikilink should return null for non-existent link", () => {
    const resolved = resolveWikilink("does-not-exist", "note-a.md", allNotes);
    expect(resolved).toBeNull();
  });

  it("backlinks: note-b should have a backlink from note-a", async () => {
    // Build the backlink relationship manually using the vault functions
    const notes = await listNotes(vaultPath);
    const backlinksToB: string[] = [];

    for (const notePath of notes) {
      const content = await readNote(vaultPath, notePath);
      const links = extractWikilinks(content);

      for (const link of links) {
        const targetBase = link.target.split("#")[0].trim();
        const resolved = resolveWikilink(targetBase, notePath, notes);
        if (resolved === "note-b.md") {
          backlinksToB.push(notePath);
        }
      }
    }

    expect(backlinksToB).toContain("note-a.md");
  });

  it("backlinks: note-c should have a backlink from note-b", async () => {
    const notes = await listNotes(vaultPath);
    const backlinksToC: string[] = [];

    for (const notePath of notes) {
      const content = await readNote(vaultPath, notePath);
      const links = extractWikilinks(content);

      for (const link of links) {
        const targetBase = link.target.split("#")[0].trim();
        const resolved = resolveWikilink(targetBase, notePath, notes);
        if (resolved === "note-c.md") {
          backlinksToC.push(notePath);
        }
      }
    }

    expect(backlinksToC).toContain("note-b.md");
  });
});

// ---------------------------------------------------------------------------
// Canvas Operations
// ---------------------------------------------------------------------------

describe("Canvas Operations", () => {
  it("readCanvasFile should parse the test canvas correctly", async () => {
    const data = await readCanvasFile(vaultPath, "test.canvas");
    expect(data.nodes).toHaveLength(2);
    expect(data.edges).toHaveLength(1);

    expect(data.nodes[0].id).toBe("node-1");
    expect(data.nodes[0].type).toBe("text");
    expect(data.nodes[0].text).toBe("First node");

    expect(data.nodes[1].id).toBe("node-2");
    expect(data.nodes[1].text).toBe("Second node");

    expect(data.edges[0].fromNode).toBe("node-1");
    expect(data.edges[0].toNode).toBe("node-2");
    expect(data.edges[0].label).toBe("connects");
  });

  it("writeCanvasFile + readCanvasFile roundtrip", async () => {
    const newCanvas: CanvasData = {
      nodes: [
        {
          id: "rt-node-1",
          type: "file",
          x: 100,
          y: 200,
          width: 300,
          height: 100,
          file: "note-a.md",
        },
        {
          id: "rt-node-2",
          type: "link",
          x: 500,
          y: 200,
          width: 300,
          height: 100,
          url: "https://example.com",
        },
      ],
      edges: [
        {
          id: "rt-edge-1",
          fromNode: "rt-node-1",
          toNode: "rt-node-2",
          fromSide: "right",
          toSide: "left",
        },
      ],
    };

    await writeCanvasFile(vaultPath, "roundtrip.canvas", newCanvas);
    const read = await readCanvasFile(vaultPath, "roundtrip.canvas");

    expect(read.nodes).toHaveLength(2);
    expect(read.edges).toHaveLength(1);
    expect(read.nodes[0].id).toBe("rt-node-1");
    expect(read.nodes[0].file).toBe("note-a.md");
    expect(read.nodes[1].url).toBe("https://example.com");
    expect(read.edges[0].fromSide).toBe("right");
    expect(read.edges[0].toSide).toBe("left");

    // cleanup
    await fs.unlink(path.join(vaultPath, "roundtrip.canvas"));
  });

  it("readCanvasFile should throw on malformed JSON", async () => {
    await fs.writeFile(
      path.join(vaultPath, "bad.canvas"),
      "not valid json{{{",
      "utf-8",
    );
    await expect(readCanvasFile(vaultPath, "bad.canvas")).rejects.toThrow(
      "Invalid canvas file",
    );
    await fs.unlink(path.join(vaultPath, "bad.canvas"));
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("Security - resolveVaultPath", () => {
  it("should block path traversal with ../../etc/passwd", () => {
    expect(() => resolveVaultPath(vaultPath, "../../etc/passwd")).toThrow(
      "Path traversal detected",
    );
  });

  it("should block path traversal with ..\\..\\Windows", () => {
    expect(() => resolveVaultPath(vaultPath, "..\\..\\Windows")).toThrow(
      "Path traversal detected",
    );
  });

  it("should block null bytes in path", () => {
    expect(() => resolveVaultPath(vaultPath, "note\0.md")).toThrow(
      "Invalid path",
    );
  });

  it("should allow valid nested paths", () => {
    const resolved = resolveVaultPath(vaultPath, "folder/nested-note.md");
    expect(resolved).toBe(path.resolve(vaultPath, "folder/nested-note.md"));
  });

  it("should allow root-level paths", () => {
    const resolved = resolveVaultPath(vaultPath, "note-a.md");
    expect(resolved).toBe(path.resolve(vaultPath, "note-a.md"));
  });

  it("should allow deeply nested valid paths", () => {
    const resolved = resolveVaultPath(vaultPath, "a/b/c/deep.md");
    expect(resolved).toBe(path.resolve(vaultPath, "a/b/c/deep.md"));
  });
});
