import { describe, it, expect } from "vitest";
import {
  parseHeadings,
  findSection,
  replaceSectionBody,
  insertAfterHeading,
  findBlockById,
  stripBlockId,
  bodyOffset,
} from "../lib/sections.js";

describe("bodyOffset", () => {
  it("returns 0 when no frontmatter present", () => {
    expect(bodyOffset("# Heading\nbody")).toBe(0);
  });

  it("skips a well-formed frontmatter block", () => {
    const c = "---\nfoo: bar\n---\n# Heading\n";
    expect(bodyOffset(c)).toBe("---\nfoo: bar\n---\n".length);
  });

  it("returns 0 for unterminated frontmatter", () => {
    const c = "---\nfoo: bar\n# Heading\n";
    expect(bodyOffset(c)).toBe(0);
  });
});

describe("parseHeadings", () => {
  it("captures level and text", () => {
    const c = "# Top\n## Sub one\n### Nested\n## Sub two\n";
    const heads = parseHeadings(c);
    expect(heads.map((h) => [h.level, h.text])).toEqual([
      [1, "Top"],
      [2, "Sub one"],
      [3, "Nested"],
      [2, "Sub two"],
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const c = "# Real\n```\n# Fake\n```\n## Also real\n";
    const heads = parseHeadings(c);
    expect(heads.map((h) => h.text)).toEqual(["Real", "Also real"]);
  });

  it("excludes frontmatter from heading scan", () => {
    const c = "---\ntitle: x\n---\n# H\n";
    const heads = parseHeadings(c);
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe("H");
  });
});

describe("findSection", () => {
  const note = `# Project\nIntro text.\n\n## Tasks\n- [ ] One\n- [ ] Two\n\n## Notes\nDetails here.\n\n# Another\nUnrelated.\n`;

  it("matches a top-level heading", () => {
    const sec = findSection(note, ["Project"]);
    expect(sec).not.toBeNull();
    expect(sec!.heading.text).toBe("Project");
    expect(note.slice(sec!.start, sec!.end)).toContain("Intro text.");
    expect(note.slice(sec!.start, sec!.end)).not.toContain("Another");
  });

  it("matches a nested heading via path", () => {
    const sec = findSection(note, ["Project", "Tasks"]);
    expect(sec).not.toBeNull();
    expect(sec!.heading.text).toBe("Tasks");
    expect(note.slice(sec!.start, sec!.end)).toContain("- [ ] One");
    expect(note.slice(sec!.start, sec!.end)).not.toContain("Notes");
  });

  it("falls back to bare heading match for single-element paths", () => {
    const sec = findSection(note, ["Tasks"]);
    expect(sec).not.toBeNull();
    expect(sec!.heading.text).toBe("Tasks");
  });

  it("is case-insensitive", () => {
    const sec = findSection(note, ["tasks"]);
    expect(sec).not.toBeNull();
  });

  it("returns null when no match", () => {
    expect(findSection(note, ["nope"])).toBeNull();
  });
});

describe("replaceSectionBody", () => {
  it("replaces only the section body, preserving heading and following sections", () => {
    const note = "# A\nold body\n## B\nb body\n";
    const sec = findSection(note, ["A"]);
    expect(sec).not.toBeNull();
    const updated = replaceSectionBody(note, sec!, "new body line");
    expect(updated).toContain("# A\n");
    expect(updated).toContain("new body line");
    expect(updated).not.toContain("old body");
    expect(updated).toContain("## B\n");
  });
});

describe("insertAfterHeading", () => {
  it("inserts content immediately after heading line", () => {
    const note = "# A\nbody\n";
    const sec = findSection(note, ["A"]);
    const out = insertAfterHeading(note, sec!, "added");
    expect(out).toBe("# A\nadded\nbody\n");
  });
});

describe("findBlockById", () => {
  it("locates a block tagged with ^id at line end", () => {
    const c = "Some paragraph. ^abc\n\nNext block.\n";
    const block = findBlockById(c, "abc");
    expect(block).not.toBeNull();
    expect(c.slice(block!.start, block!.end)).toContain("Some paragraph.");
  });

  it("walks backward to start of paragraph", () => {
    const c = "first line\nsecond line ^xyz\n\nnext block\n";
    const block = findBlockById(c, "xyz");
    expect(block).not.toBeNull();
    expect(c.slice(block!.start, block!.end)).toContain("first line");
    expect(c.slice(block!.start, block!.end)).toContain("second line");
  });

  it("ignores ^id markers inside fenced code blocks", () => {
    const c = "```\nfake ^id1\n```\nreal ^id1\n";
    const block = findBlockById(c, "id1");
    expect(block).not.toBeNull();
    expect(c.slice(block!.start, block!.end)).toContain("real");
    expect(c.slice(block!.start, block!.end)).not.toContain("fake");
  });

  it("returns null when no match", () => {
    expect(findBlockById("nothing here\n", "missing")).toBeNull();
  });
});

describe("stripBlockId", () => {
  it("drops the trailing ^id token", () => {
    expect(stripBlockId("hello world ^abc")).toBe("hello world");
  });
});
