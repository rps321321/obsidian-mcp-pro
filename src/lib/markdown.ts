import matter from "gray-matter";
import path from "path";
import type { NoteMetadata, LinkInfo } from "../types.js";

/**
 * Parse YAML frontmatter from markdown content.
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const result = matter(content);
  return {
    data: result.data as Record<string, unknown>,
    content: result.content,
  };
}

/**
 * Parse existing frontmatter, merge with updates, and return full content
 * with updated frontmatter. Creates frontmatter if none exists.
 */
export function updateFrontmatter(
  content: string,
  updates: Record<string, unknown>,
): string {
  const parsed = matter(content);
  const merged = { ...parsed.data, ...updates };
  return matter.stringify(parsed.content, merged);
}

/**
 * Track whether a line is inside a fenced code block.
 * Returns a function that, given a line, returns true if the line
 * is inside a code block (should be skipped).
 */
function createCodeBlockTracker(): (line: string) => boolean {
  let insideCodeBlock = false;
  return (line: string): boolean => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      insideCodeBlock = !insideCodeBlock;
      return true; // skip the fence line itself
    }
    return insideCodeBlock;
  };
}

/**
 * Strip inline code spans from a line so patterns inside them are ignored.
 */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, "");
}

/**
 * Extract all wikilinks and embeds from markdown content.
 * Ignores links inside code blocks and inline code.
 */
export function extractWikilinks(content: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  const lines = content.split("\n");
  const isInsideCodeBlock = createCodeBlockTracker();

  // Match both ![[...]] embeds and [[...]] links
  const wikilinkRegex = /(!)?\[\[([^\]]+?)\]\]/g;

  for (const line of lines) {
    if (isInsideCodeBlock(line)) continue;

    const cleaned = stripInlineCode(line);
    let match: RegExpExecArray | null;

    // Reset lastIndex for each line
    wikilinkRegex.lastIndex = 0;

    while ((match = wikilinkRegex.exec(cleaned)) !== null) {
      const isEmbed = match[1] === "!";
      const inner = match[2];

      // Split on first pipe for display text
      const pipeIndex = inner.indexOf("|");
      const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
      const displayText =
        pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : undefined;

      links.push({
        source: "", // caller fills in
        target: target.trim(),
        displayText: displayText?.trim(),
        isEmbed,
      });
    }
  }

  return links;
}

/**
 * Extract inline tags and frontmatter tags from markdown content.
 * Returns deduplicated tags without the `#` prefix.
 * Ignores tags inside code blocks and inline code.
 */
export function extractTags(content: string): string[] {
  const tagSet = new Set<string>();

  // Extract frontmatter tags
  const { data, content: body } = parseFrontmatter(content);
  if (data.tags) {
    if (Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        const t = String(tag).trim();
        if (t) tagSet.add(t);
      }
    } else if (typeof data.tags === "string") {
      for (const tag of data.tags.split(",")) {
        const t = tag.trim();
        if (t) tagSet.add(t);
      }
    }
  }

  // Extract inline tags from body
  const lines = body.split("\n");
  const isInsideCodeBlock = createCodeBlockTracker();
  const tagRegex = /(?:^|\s)#([a-zA-Z0-9_/-]+)/g;

  for (const line of lines) {
    if (isInsideCodeBlock(line)) continue;

    const cleaned = stripInlineCode(line);
    let match: RegExpExecArray | null;
    tagRegex.lastIndex = 0;

    while ((match = tagRegex.exec(cleaned)) !== null) {
      tagSet.add(match[1]);
    }
  }

  return [...tagSet];
}

/**
 * Extract aliases from frontmatter `aliases` field.
 */
export function extractAliases(content: string): string[] {
  const { data } = parseFrontmatter(content);
  if (!data.aliases) return [];

  if (Array.isArray(data.aliases)) {
    return data.aliases.map((a: unknown) => String(a).trim()).filter(Boolean);
  }

  if (typeof data.aliases === "string") {
    return data.aliases
      .split(",")
      .map((a: string) => a.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Build a complete NoteMetadata object from a note's content and file stats.
 */
export function buildNoteMetadata(
  vaultPath: string,
  relativePath: string,
  content: string,
  stats: { size: number; created: Date | null; modified: Date | null },
): NoteMetadata {
  const { data } = parseFrontmatter(content);
  const tags = extractTags(content);
  const aliases = extractAliases(content);

  // Title: frontmatter title or filename without extension
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : path.basename(relativePath, path.extname(relativePath));

  return {
    title,
    path: path.join(vaultPath, relativePath),
    relativePath,
    created: stats.created,
    modified: stats.modified,
    size: stats.size,
    tags,
    frontmatter: data,
    aliases,
  };
}

/**
 * Resolve a wikilink target to an actual file path using Obsidian's
 * shortest-path matching strategy.
 * Returns null if no match is found.
 */
export function resolveWikilink(
  link: string,
  _currentNotePath: string,
  allNotePaths: string[],
): string | null {
  // Normalize: strip .md if present, we'll compare basenames
  const normalizedLink = link.replace(/\.md$/i, "");

  // Exact relative path match (with or without extension)
  for (const notePath of allNotePaths) {
    const withoutExt = notePath.replace(/\.md$/i, "");
    if (withoutExt === normalizedLink) return notePath;
  }

  // Match by path suffix — handles [[folder/note]] style links
  if (normalizedLink.includes("/")) {
    for (const notePath of allNotePaths) {
      const withoutExt = notePath.replace(/\.md$/i, "");
      if (withoutExt.endsWith(normalizedLink)) {
        // Ensure the match is at a path boundary
        const prefix = withoutExt.slice(
          0,
          withoutExt.length - normalizedLink.length,
        );
        if (prefix === "" || prefix.endsWith("/")) return notePath;
      }
    }
  }

  // Shortest-path: match by basename only
  const linkBasename = path.basename(normalizedLink).toLowerCase();
  const candidates: string[] = [];

  for (const notePath of allNotePaths) {
    const noteBasename = path
      .basename(notePath, path.extname(notePath))
      .toLowerCase();
    if (noteBasename === linkBasename) {
      candidates.push(notePath);
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple matches: pick the one closest to the current note
  // Obsidian prefers the shortest path from the vault root
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}
