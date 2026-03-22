import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  updateFrontmatter,
  extractWikilinks,
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
