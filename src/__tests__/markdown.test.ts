import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  updateFrontmatter,
  extractWikilinks,
  extractWikilinkSpans,
  extractMarkdownLinkSpans,
  formatWikilinkTarget,
  extractTags,
  extractAliases,
  resolveWikilink,
  buildNoteMetadata,
} from "../lib/markdown.js";

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------
describe("parseFrontmatter", () => {
  it("should parse valid YAML frontmatter", () => {
    const content = `---
title: Hello World
tags:
  - foo
  - bar
---
Body text here.`;
    const result = parseFrontmatter(content);
    expect(result.data.title).toBe("Hello World");
    expect(result.data.tags).toEqual(["foo", "bar"]);
    expect(result.content.trim()).toBe("Body text here.");
  });

  it("should return empty data when no frontmatter is present", () => {
    const content = "Just some markdown text.";
    const result = parseFrontmatter(content);
    expect(result.data).toEqual({});
    expect(result.content.trim()).toBe("Just some markdown text.");
  });

  it("should return body without frontmatter delimiters", () => {
    const content = `---
key: value
---
The body.`;
    const result = parseFrontmatter(content);
    expect(result.content).not.toContain("---");
    expect(result.content.trim()).toBe("The body.");
  });

  it("should handle an empty file", () => {
    const result = parseFrontmatter("");
    expect(result.data).toEqual({});
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// updateFrontmatter
// ---------------------------------------------------------------------------
describe("updateFrontmatter", () => {
  it("should merge new properties into existing frontmatter", () => {
    const content = `---
title: Original
---
Body text.`;
    const updated = updateFrontmatter(content, { draft: true });
    const parsed = parseFrontmatter(updated);
    expect(parsed.data.title).toBe("Original");
    expect(parsed.data.draft).toBe(true);
    expect(parsed.content.trim()).toBe("Body text.");
  });

  it("should create frontmatter when none exists", () => {
    const content = "Plain body.";
    const updated = updateFrontmatter(content, { title: "New" });
    const parsed = parseFrontmatter(updated);
    expect(parsed.data.title).toBe("New");
    expect(parsed.content.trim()).toBe("Plain body.");
  });

  it("should preserve body content", () => {
    const body = "Line 1\n\nLine 2\n\n- list item";
    const content = `---
a: 1
---
${body}`;
    const updated = updateFrontmatter(content, { b: 2 });
    const parsed = parseFrontmatter(updated);
    expect(parsed.content.trim()).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------
describe("extractWikilinks", () => {
  it("should extract [[note]] links", () => {
    const links = extractWikilinks("See [[My Note]] for details.");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("My Note");
    expect(links[0].isEmbed).toBe(false);
    expect(links[0].displayText).toBeUndefined();
  });

  it("should extract [[note|display text]] with alias", () => {
    const links = extractWikilinks("Link to [[target|shown text]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("target");
    expect(links[0].displayText).toBe("shown text");
  });

  it("should extract embeds ![[file]]", () => {
    const links = extractWikilinks("Embed: ![[image.png]]");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("image.png");
    expect(links[0].isEmbed).toBe(true);
  });

  it("should ignore links inside backtick code blocks", () => {
    const content = "```\n[[inside code]]\n```\n[[outside]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("outside");
  });

  it("should ignore links inside tilde ~~~ code blocks", () => {
    const content = "~~~\n[[inside tilde]]\n~~~\n[[outside]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("outside");
  });

  it("should ignore links inside inline code", () => {
    const links = extractWikilinks("Use `[[not a link]]` in code.");
    expect(links).toHaveLength(0);
  });

  it("should handle [[note#heading]] with anchor", () => {
    const links = extractWikilinks("See [[note#heading]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("note#heading");
  });

  it("should handle [[note^blockref]]", () => {
    const links = extractWikilinks("Ref [[note^abc123]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("note^abc123");
  });

  it("should return empty array for no links", () => {
    const links = extractWikilinks("No links here.");
    expect(links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------
describe("extractTags", () => {
  it("should extract #tag from body", () => {
    const tags = extractTags("Some text #todo more text");
    expect(tags).toContain("todo");
  });

  it("should extract #nested/tag", () => {
    const tags = extractTags("Text #project/alpha end");
    expect(tags).toContain("project/alpha");
  });

  it("should extract tags from frontmatter tags array", () => {
    const content = `---
tags:
  - idea
  - review
---
Body text.`;
    const tags = extractTags(content);
    expect(tags).toContain("idea");
    expect(tags).toContain("review");
  });

  it("should extract tags from frontmatter tags comma-separated string", () => {
    const content = `---
tags: "idea, review, draft"
---
Body text.`;
    const tags = extractTags(content);
    expect(tags).toContain("idea");
    expect(tags).toContain("review");
    expect(tags).toContain("draft");
  });

  it("should extract tags from frontmatter tag (singular)", () => {
    const content = `---
tag: solo
---
Body.`;
    const tags = extractTags(content);
    expect(tags).toContain("solo");
  });

  it("should ignore tags inside code blocks", () => {
    const content = "```\n#hidden\n```\n#visible";
    const tags = extractTags(content);
    expect(tags).toContain("visible");
    expect(tags).not.toContain("hidden");
  });

  it("should ignore tags inside inline code", () => {
    const tags = extractTags("Use `#not-a-tag` in code. #real-tag");
    expect(tags).toContain("real-tag");
    expect(tags).not.toContain("not-a-tag");
  });

  it("should NOT extract ATX headings as tags", () => {
    const tags = extractTags("# Heading\nSome body text.");
    expect(tags).not.toContain("Heading");
    expect(tags).toHaveLength(0);
  });

  it("should NOT extract ## Heading as tags", () => {
    const tags = extractTags("## Sub Heading\nBody.");
    expect(tags).not.toContain("#");
    expect(tags).not.toContain("Sub");
    expect(tags).toHaveLength(0);
  });

  it("should deduplicate tags", () => {
    const content = `---
tags:
  - dup
---
#dup and more #dup`;
    const tags = extractTags(content);
    const dupCount = tags.filter((t) => t === "dup").length;
    expect(dupCount).toBe(1);
  });

  it("should handle Unicode tags", () => {
    const tags = extractTags("Text #cafe end");
    expect(tags).toContain("cafe");
    // Also test extended Latin
    const tags2 = extractTags("Text #resume end");
    expect(tags2).toContain("resume");
  });
});

// ---------------------------------------------------------------------------
// extractAliases
// ---------------------------------------------------------------------------
describe("extractAliases", () => {
  it("should extract from aliases array", () => {
    const content = `---
aliases:
  - Foo
  - Bar
---
Body.`;
    const aliases = extractAliases(content);
    expect(aliases).toEqual(["Foo", "Bar"]);
  });

  it("should extract from aliases comma-separated string", () => {
    const content = `---
aliases: "Foo, Bar, Baz"
---
Body.`;
    const aliases = extractAliases(content);
    expect(aliases).toEqual(["Foo", "Bar", "Baz"]);
  });

  it("should extract from alias (singular)", () => {
    const content = `---
alias: SingleAlias
---
Body.`;
    const aliases = extractAliases(content);
    expect(aliases).toEqual(["SingleAlias"]);
  });

  it("should return empty array if no aliases", () => {
    const aliases = extractAliases("No frontmatter here.");
    expect(aliases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveWikilink
// ---------------------------------------------------------------------------
describe("resolveWikilink", () => {
  const allPaths = [
    "notes/daily/2024-01-01.md",
    "notes/projects/Alpha.md",
    "notes/Projects/beta.md",
    "archive/Alpha.md",
    "zettelkasten/unique-note.md",
    "folder/sub/deep.md",
  ];

  it("should resolve by exact path match", () => {
    const result = resolveWikilink("notes/projects/Alpha", "any.md", allPaths);
    expect(result).toBe("notes/projects/Alpha.md");
  });

  it("should resolve by basename-only match (shortest path)", () => {
    const result = resolveWikilink("unique-note", "any.md", allPaths);
    expect(result).toBe("zettelkasten/unique-note.md");
  });

  it("should match case-insensitively", () => {
    const result = resolveWikilink("notes/projects/alpha", "any.md", allPaths);
    expect(result).toBe("notes/projects/Alpha.md");
  });

  it("should strip .md extension before matching", () => {
    const result = resolveWikilink("unique-note.md", "any.md", allPaths);
    expect(result).toBe("zettelkasten/unique-note.md");
  });

  it("should strip #heading anchor before matching", () => {
    const result = resolveWikilink(
      "unique-note#some-heading",
      "any.md",
      allPaths,
    );
    expect(result).toBe("zettelkasten/unique-note.md");
  });

  it("should strip ^blockref before matching", () => {
    const result = resolveWikilink("unique-note^abc123", "any.md", allPaths);
    expect(result).toBe("zettelkasten/unique-note.md");
  });

  it("should return null for unresolved links", () => {
    const result = resolveWikilink("nonexistent", "any.md", allPaths);
    expect(result).toBeNull();
  });

  it("should handle path with folder [[folder/note]]", () => {
    const result = resolveWikilink("sub/deep", "any.md", allPaths);
    expect(result).toBe("folder/sub/deep.md");
  });
});

// ---------------------------------------------------------------------------
// buildNoteMetadata
// ---------------------------------------------------------------------------
describe("buildNoteMetadata", () => {
  const stats = {
    size: 1024,
    created: new Date("2024-01-15T10:00:00Z"),
    modified: new Date("2024-06-20T14:30:00Z"),
  };

  it("should build correct metadata from content and stats", () => {
    const content = `---
tags:
  - project
aliases:
  - MyAlias
---
Some body #inline-tag with [[link]].`;

    const meta = buildNoteMetadata(
      "/vault",
      "notes/test.md",
      content,
      stats,
    );

    expect(meta.relativePath).toBe("notes/test.md");
    expect(meta.size).toBe(1024);
    expect(meta.created).toEqual(new Date("2024-01-15T10:00:00Z"));
    expect(meta.modified).toEqual(new Date("2024-06-20T14:30:00Z"));
    expect(meta.tags).toContain("project");
    expect(meta.tags).toContain("inline-tag");
    expect(meta.aliases).toEqual(["MyAlias"]);
    expect(meta.frontmatter.tags).toEqual(["project"]);
  });

  it("should use frontmatter title if present", () => {
    const content = `---
title: Custom Title
---
Body.`;
    const meta = buildNoteMetadata("/vault", "notes/file.md", content, stats);
    expect(meta.title).toBe("Custom Title");
  });

  it("should fall back to filename for title", () => {
    const content = "No frontmatter, plain body.";
    const meta = buildNoteMetadata("/vault", "notes/my-note.md", content, stats);
    expect(meta.title).toBe("my-note");
  });
});

// ---------------------------------------------------------------------------
// extractWikilinkSpans
// ---------------------------------------------------------------------------
describe("extractWikilinkSpans", () => {
  it("returns offsets covering the full [[...]] match", () => {
    const c = "see [[foo]] then";
    const spans = extractWikilinkSpans(c);
    expect(spans).toHaveLength(1);
    expect(c.slice(spans[0].start, spans[0].end)).toBe("[[foo]]");
    expect(spans[0].target).toBe("foo");
    expect(spans[0].fragment).toBe("");
    expect(spans[0].alias).toBeUndefined();
    expect(spans[0].isEmbed).toBe(false);
  });

  it("captures embed prefix in the span", () => {
    const c = "img: ![[pic.png]]";
    const spans = extractWikilinkSpans(c);
    expect(spans[0].isEmbed).toBe(true);
    expect(c.slice(spans[0].start, spans[0].end)).toBe("![[pic.png]]");
  });

  it("splits alias and fragment", () => {
    const c = "x [[note#Heading|Display]] y";
    const [span] = extractWikilinkSpans(c);
    expect(span.target).toBe("note");
    expect(span.fragment).toBe("#Heading");
    expect(span.alias).toBe("Display");
  });

  it("handles block-id fragments", () => {
    const [span] = extractWikilinkSpans("ref [[note#^abc123]] here");
    expect(span.target).toBe("note");
    expect(span.fragment).toBe("#^abc123");
  });

  it("skips wikilinks inside fenced code blocks", () => {
    const c = ["before [[real]]", "```", "[[notreal]]", "```", "after"].join("\n");
    const spans = extractWikilinkSpans(c);
    expect(spans).toHaveLength(1);
    expect(spans[0].target).toBe("real");
  });

  it("skips wikilinks inside inline code", () => {
    const c = "kept [[hit]] but `[[skip]]` not";
    const spans = extractWikilinkSpans(c);
    expect(spans.map((s) => s.target)).toEqual(["hit"]);
  });

  it("captures multiple links per line with correct offsets", () => {
    const c = "[[a]] then [[b]] then [[c]]";
    const spans = extractWikilinkSpans(c);
    expect(spans.map((s) => c.slice(s.start, s.end))).toEqual([
      "[[a]]",
      "[[b]]",
      "[[c]]",
    ]);
  });

  it("offsets account for newlines across lines", () => {
    const c = "line one\nline two [[target]] here\nthird";
    const [span] = extractWikilinkSpans(c);
    expect(c.slice(span.start, span.end)).toBe("[[target]]");
  });
});

// ---------------------------------------------------------------------------
// extractMarkdownLinkSpans
// ---------------------------------------------------------------------------
describe("extractMarkdownLinkSpans", () => {
  it("extracts a basic [text](url) link", () => {
    const c = "[hello](world.md) yes";
    const [span] = extractMarkdownLinkSpans(c);
    expect(c.slice(span.start, span.end)).toBe("[hello](world.md)");
    expect(span.text).toBe("hello");
    expect(span.urlPath).toBe("world.md");
    expect(span.fragment).toBe("");
    expect(span.isEmbed).toBe(false);
  });

  it("splits the URL fragment", () => {
    const [span] = extractMarkdownLinkSpans("[x](a/b.md#Heading)");
    expect(span.urlPath).toBe("a/b.md");
    expect(span.fragment).toBe("#Heading");
  });

  it("captures embed prefix", () => {
    const [span] = extractMarkdownLinkSpans("![alt](pic.png)");
    expect(span.isEmbed).toBe(true);
  });

  it("captures trailing title without losing it", () => {
    const c = '[a](url.md "the title")';
    const [span] = extractMarkdownLinkSpans(c);
    expect(span.urlPath).toBe("url.md");
    expect(span.title).toBe(' "the title"');
    expect(c.slice(span.start, span.end)).toBe(c);
  });

  it("skips markdown links inside fenced code blocks", () => {
    const c = "[real](r.md)\n```\n[skip](s.md)\n```\n[also-real](r2.md)";
    const spans = extractMarkdownLinkSpans(c);
    expect(spans.map((s) => s.urlPath)).toEqual(["r.md", "r2.md"]);
  });

  it("skips markdown links inside inline code", () => {
    const c = "[a](b.md) and `[c](d.md)` and [e](f.md)";
    const spans = extractMarkdownLinkSpans(c);
    expect(spans.map((s) => s.urlPath)).toEqual(["b.md", "f.md"]);
  });
});

// ---------------------------------------------------------------------------
// formatWikilinkTarget
// ---------------------------------------------------------------------------
describe("formatWikilinkTarget", () => {
  it("keeps basename form when post-move basename is unambiguous", () => {
    const out = formatWikilinkTarget("projects/idea.md", "idea", [
      "projects/idea.md",
      "other.md",
    ]);
    expect(out).toBe("idea");
  });

  it("falls back to path form when basename collides", () => {
    const out = formatWikilinkTarget("archive/idea.md", "idea", [
      "archive/idea.md",
      "projects/idea.md",
    ]);
    expect(out).toBe("archive/idea");
  });

  it("preserves path form when original used a path", () => {
    const out = formatWikilinkTarget("projects/idea.md", "inbox/idea", [
      "projects/idea.md",
    ]);
    expect(out).toBe("projects/idea");
  });

  it("strips the .md extension on output", () => {
    const out = formatWikilinkTarget("a/b/c.md", "c", ["a/b/c.md"]);
    expect(out).toBe("c");
  });
});
