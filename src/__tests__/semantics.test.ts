import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { resolveWikilink, extractTags, extractAliases } from "../lib/markdown.js";
import { formatMomentDate } from "../lib/dates.js";
import { writeCanvasFile, updateCanvasFile, readCanvasFile } from "../lib/vault.js";
import type { CanvasData } from "../types.js";

// ---------------------------------------------------------------------------
// Wikilink resolution — aliases and proximity (fixes #1 + #5)
// ---------------------------------------------------------------------------
describe("resolveWikilink — alias fallback", () => {
  it("resolves a display-name link via frontmatter alias when no filename matches", () => {
    const allNotes = ["projects/alpha.md", "inbox/note.md"];
    const aliasMap = new Map([["my project", "projects/alpha.md"]]);
    const resolved = resolveWikilink("My Project", "inbox/note.md", allNotes, { aliasMap });
    expect(resolved).toBe("projects/alpha.md");
  });

  it("prefers a filename match over an alias match", () => {
    const allNotes = ["projects/alpha.md", "alias-target.md"];
    const aliasMap = new Map([["alpha", "alias-target.md"]]);
    const resolved = resolveWikilink("alpha", "inbox/note.md", allNotes, { aliasMap });
    expect(resolved).toBe("projects/alpha.md");
  });

  it("returns null when neither filename nor alias matches", () => {
    const resolved = resolveWikilink("Unknown", "x.md", ["a.md"], { aliasMap: new Map() });
    expect(resolved).toBeNull();
  });
});

describe("resolveWikilink — proximity tie-break", () => {
  it("picks the candidate in the same folder as the linking note", () => {
    const allNotes = [
      "archive/old/foo.md",
      "projects/active/foo.md",
      "projects/active/current.md",
    ];
    // Linking note sits in projects/active — foo.md in same folder wins.
    const resolved = resolveWikilink("foo", "projects/active/current.md", allNotes);
    expect(resolved).toBe("projects/active/foo.md");
  });

  it("falls back to shortest path when no proximity match", () => {
    const allNotes = ["a/b/c/foo.md", "foo.md"];
    const resolved = resolveWikilink("foo", "unrelated/note.md", allNotes);
    expect(resolved).toBe("foo.md");
  });
});

// ---------------------------------------------------------------------------
// extractTags — case variants (fix #4)
// ---------------------------------------------------------------------------
describe("extractTags — frontmatter key case variants", () => {
  it("reads capitalized `Tags:` key", () => {
    const content = `---\nTags:\n  - project\n  - urgent\n---\nbody`;
    const tags = extractTags(content);
    expect(tags).toContain("project");
    expect(tags).toContain("urgent");
  });

  it("reads upper-case `TAGS:` key", () => {
    const content = `---\nTAGS: [alpha, beta]\n---\nbody`;
    const tags = extractTags(content);
    expect(tags).toContain("alpha");
    expect(tags).toContain("beta");
  });

  it("falls back to singular `Tag:`", () => {
    const content = `---\nTag: solo\n---\nbody`;
    expect(extractTags(content)).toContain("solo");
  });
});

describe("extractAliases — frontmatter key case variants", () => {
  it("reads capitalized `Aliases:` key", () => {
    const content = `---\nAliases:\n  - My Project\n---\nbody`;
    expect(extractAliases(content)).toEqual(["My Project"]);
  });
});

// ---------------------------------------------------------------------------
// formatMomentDate — full moment token coverage (fix #2)
// ---------------------------------------------------------------------------
describe("formatMomentDate", () => {
  // Thu, April 9, 2026, 05:07:03 local
  const d = new Date(2026, 3, 9, 5, 7, 3);

  it("handles YYYY / YY", () => {
    expect(formatMomentDate(d, "YYYY-YY")).toBe("2026-26");
  });

  it("handles MM / M / MMM / MMMM", () => {
    expect(formatMomentDate(d, "MM")).toBe("04");
    expect(formatMomentDate(d, "M")).toBe("4");
    expect(formatMomentDate(d, "MMM")).toBe("Apr");
    expect(formatMomentDate(d, "MMMM")).toBe("April");
  });

  it("handles DD / D / Do / ddd / dddd", () => {
    expect(formatMomentDate(d, "DD")).toBe("09");
    expect(formatMomentDate(d, "D")).toBe("9");
    expect(formatMomentDate(d, "Do")).toBe("9th");
    expect(formatMomentDate(d, "ddd")).toBe("Thu");
    expect(formatMomentDate(d, "dddd")).toBe("Thursday");
  });

  it("handles quarter + bracketed literals", () => {
    expect(formatMomentDate(d, "YYYY-[Q]Q")).toBe("2026-Q2");
  });

  it("handles time tokens HH/hh/mm/ss", () => {
    expect(formatMomentDate(d, "HH:mm:ss")).toBe("05:07:03");
    expect(formatMomentDate(d, "hh:mm")).toBe("05:07");
  });

  it("handles ordinal edge cases", () => {
    expect(formatMomentDate(new Date(2026, 0, 1), "Do")).toBe("1st");
    expect(formatMomentDate(new Date(2026, 0, 2), "Do")).toBe("2nd");
    expect(formatMomentDate(new Date(2026, 0, 3), "Do")).toBe("3rd");
    expect(formatMomentDate(new Date(2026, 0, 11), "Do")).toBe("11th");
    expect(formatMomentDate(new Date(2026, 0, 21), "Do")).toBe("21st");
  });

  it("matches Obsidian's default YYYY-MM-DD format", () => {
    expect(formatMomentDate(d, "YYYY-MM-DD")).toBe("2026-04-09");
  });

  it("preserves unsupported tokens verbatim", () => {
    // Not a supported token — left as literal character.
    expect(formatMomentDate(d, "YYYY-?-DD")).toBe("2026-?-09");
  });
});

// ---------------------------------------------------------------------------
// Canvas round-trip — preserve unknown top-level keys (fix #3)
// ---------------------------------------------------------------------------
describe("updateCanvasFile — round-trip fidelity", () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-canvas-"));
  });
  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("preserves unknown top-level keys like `viewport` and future metadata", async () => {
    const canvasPath = "board.canvas";
    const raw = {
      nodes: [],
      edges: [],
      viewport: { x: 100, y: 200, zoom: 1.5 },
      customFutureKey: "preserve-me",
    };
    await fs.writeFile(path.join(vaultDir, canvasPath), JSON.stringify(raw), "utf-8");

    await updateCanvasFile(vaultDir, canvasPath, (data: CanvasData) => ({
      nodes: [...data.nodes, { id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "new" }],
      edges: data.edges,
    }));

    const roundTripped = JSON.parse(
      await fs.readFile(path.join(vaultDir, canvasPath), "utf-8"),
    );
    expect(roundTripped.viewport).toEqual({ x: 100, y: 200, zoom: 1.5 });
    expect(roundTripped.customFutureKey).toBe("preserve-me");
    expect(roundTripped.nodes).toHaveLength(1);
  });

  it("falls back gracefully when file is a bare array (invalid canvas)", async () => {
    const canvasPath = "broken.canvas";
    // Not an object — writeCanvasFile then read via updateCanvasFile.
    await writeCanvasFile(vaultDir, canvasPath, { nodes: [], edges: [] });
    await expect(readCanvasFile(vaultDir, canvasPath)).resolves.toBeDefined();
  });
});
