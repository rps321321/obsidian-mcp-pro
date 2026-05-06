import { describe, it, expect } from "vitest";
import { chunkNote } from "../lib/chunker.js";

describe("chunkNote", () => {
  it("returns at least one chunk for any non-empty body", () => {
    const chunks = chunkNote("hello world\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("hello world");
  });

  it("strips frontmatter from the embedded text", () => {
    const chunks = chunkNote("---\nfoo: bar\n---\nbody text\n");
    expect(chunks[0].text).not.toContain("foo: bar");
    expect(chunks[0].text).toContain("body text");
  });

  it("prefixes chunks with the title and aliases when set in frontmatter", () => {
    const chunks = chunkNote("---\ntitle: My Project\naliases: [Atlas]\n---\nbody\n");
    expect(chunks[0].text.startsWith("My Project / Atlas")).toBe(true);
  });

  it("splits on H2/H3 headings into separate chunks", () => {
    const note = `# Top\nintro\n## Section A\nA-body\n## Section B\nB-body\n`;
    const chunks = chunkNote(note);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes("Section A") && t.includes("A-body"))).toBe(true);
    expect(texts.some((t) => t.includes("Section B") && t.includes("B-body"))).toBe(true);
    // Each section's chunk does NOT bleed into the next.
    const aChunk = chunks.find((c) => c.headingPath.includes("Section A"))!;
    expect(aChunk.text).not.toContain("B-body");
  });

  it("further splits oversized sections by paragraph window", () => {
    const para = "This is a sentence. ".repeat(100); // ~2000 chars
    const note = `## Big\n${para}\n`;
    const chunks = chunkNote(note, { targetChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(800); // some slack for prefix
    }
  });

  it("preserves the heading path on each chunk", () => {
    const note = `# Project\n## Tasks\nbody\n### Sub\nmore\n`;
    const chunks = chunkNote(note);
    expect(chunks.some((c) => c.headingPath.join("/") === "Project/Tasks")).toBe(true);
    expect(chunks.some((c) => c.headingPath.join("/") === "Project/Tasks/Sub")).toBe(true);
  });
});
