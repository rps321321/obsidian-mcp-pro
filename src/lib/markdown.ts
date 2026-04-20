import matter from "gray-matter";
import path from "path";
import type { NoteMetadata, LinkInfo } from "../types.js";

/**
 * Parse YAML frontmatter from markdown content. Malformed YAML yields empty
 * data and the raw content — a single broken note must not abort vault-wide
 * loops (tag enumeration, frontmatter search, link graph).
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  content: string;
} {
  try {
    const result = matter(content);
    return {
      data: result.data as Record<string, unknown>,
      content: result.content,
    };
  } catch {
    return { data: {}, content };
  }
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
  let fenceChar = "";
  let fenceLength = 0;
  return (line: string): boolean => {
    const trimmed = line.trimStart();
    if (!insideCodeBlock) {
      const backtickMatch = trimmed.match(/^(`{3,})/);
      const tildeMatch = trimmed.match(/^(~{3,})/);
      if (backtickMatch) {
        insideCodeBlock = true;
        fenceChar = "`";
        fenceLength = backtickMatch[1].length;
        return true;
      }
      if (tildeMatch) {
        insideCodeBlock = true;
        fenceChar = "~";
        fenceLength = tildeMatch[1].length;
        return true;
      }
      return false;
    } else {
      const closePattern = new RegExp(`^${fenceChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}{${fenceLength},}\\s*$`);
      if (closePattern.test(trimmed)) {
        insideCodeBlock = false;
        return true;
      }
      return true;
    }
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

  // Extract frontmatter tags. Obsidian's Properties editor writes lowercase
  // `tags:`, but hand-edited vaults commonly have `Tags:` or `TAGS:`. YAML
  // keys are case-sensitive, so probe common casings explicitly.
  const { data, content: body } = parseFrontmatter(content);
  const tagFieldValue =
    data.tags ?? data.Tags ?? data.TAGS ?? data.tag ?? data.Tag;
  if (tagFieldValue) {
    if (Array.isArray(tagFieldValue)) {
      for (const tag of tagFieldValue) {
        const t = String(tag).trim();
        if (t) tagSet.add(t);
      }
    } else if (typeof tagFieldValue === "string") {
      for (const tag of tagFieldValue.split(",")) {
        const t = tag.trim();
        if (t) tagSet.add(t);
      }
    }
  }

  // Extract inline tags from body
  const lines = body.split("\n");
  const isInsideCodeBlock = createCodeBlockTracker();
  const tagRegex = /(?:^|\s)#([a-zA-Z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF_][a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF_/-]*)/g;

  for (const line of lines) {
    if (isInsideCodeBlock(line)) continue;

    // Skip ATX headings
    if (/^\s*#{1,6}\s/.test(line)) continue;

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
  const aliasField =
    data.aliases ?? data.Aliases ?? data.ALIASES ?? data.alias ?? data.Alias;
  if (!aliasField) return [];

  if (Array.isArray(aliasField)) {
    return aliasField.map((a: unknown) => String(a).trim()).filter(Boolean);
  }

  if (typeof aliasField === "string") {
    return aliasField.split(",").map((a: string) => a.trim()).filter(Boolean);
  }

  return [];
}

/**
 * Build a complete NoteMetadata object from a note's content and file stats.
 */
export function buildNoteMetadata(
  _vaultPath: string,
  relativePath: string,
  content: string,
  stats: { size: number; created: Date | null; modified: Date | null },
): NoteMetadata {
  const { data } = parseFrontmatter(content);
  const tags = extractTags(content);
  const aliases = extractAliases(content);

  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : path.basename(relativePath, path.extname(relativePath));

  return {
    title,
    relativePath,
    created: stats.created,
    modified: stats.modified,
    size: stats.size,
    tags,
    frontmatter: data,
    aliases,
  };
}

/** Count the number of leading path segments shared between two paths. */
function sharedPathDepth(a: string, b: string): number {
  const as = a.toLowerCase().split("/");
  const bs = b.toLowerCase().split("/");
  let i = 0;
  const max = Math.min(as.length, bs.length);
  while (i < max && as[i] === bs[i]) i++;
  return i;
}

export interface ResolveWikilinkOptions {
  /** Map of lowercased alias → target note path. Used as a fallback when
   *  filename/path matching finds no candidate. */
  aliasMap?: Map<string, string>;
}

/**
 * Resolve a wikilink target to an actual file path.
 *
 * Resolution order matches Obsidian:
 *   1. Exact relative-path match (case-insensitive)
 *   2. Path-suffix match (case-insensitive)
 *   3. Basename match — with proximity-based tie-break: prefer the
 *      candidate that shares the deepest path prefix with the linking
 *      note, falling back to shortest vault path on ties.
 *   4. Alias match — frontmatter `aliases` on any other note.
 *
 * Returns null if nothing matches.
 */
export function resolveWikilink(
  link: string,
  currentNotePath: string,
  allNotePaths: string[],
  options: ResolveWikilinkOptions = {},
): string | null {
  // Strip heading anchors (`#...`) AND bare block refs (`^...`). Obsidian's
  // own block-ref syntax is `note#^id`, so `#` splits first and `^` is dead
  // in that case — but callers sometimes pass bare `note^id` strings and we
  // still handle them.
  const cleanLink = link.split("#")[0].split("^")[0].trim();
  if (!cleanLink) return null;

  const normalizedLink = cleanLink.replace(/\.md$/i, "");
  const normalizedLinkLower = normalizedLink.toLowerCase();

  // 1. Exact relative-path match
  for (const notePath of allNotePaths) {
    const withoutExt = notePath.replace(/\.md$/i, "").toLowerCase();
    if (withoutExt === normalizedLinkLower) return notePath;
  }

  // 2. Path-suffix match
  if (normalizedLink.includes("/")) {
    for (const notePath of allNotePaths) {
      const withoutExt = notePath.replace(/\.md$/i, "").toLowerCase();
      if (withoutExt.endsWith(normalizedLinkLower)) {
        const prefix = withoutExt.slice(0, withoutExt.length - normalizedLinkLower.length);
        if (prefix === "" || prefix.endsWith("/")) return notePath;
      }
    }
  }

  // 3. Basename match
  const linkBasename = path.basename(normalizedLink).toLowerCase();
  const candidates: string[] = [];
  for (const notePath of allNotePaths) {
    const noteBasename = path
      .basename(notePath, path.extname(notePath))
      .toLowerCase();
    if (noteBasename === linkBasename) candidates.push(notePath);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Obsidian's actual rule is "nearest to the linking note" — the candidate
    // that shares the deepest directory prefix with `currentNotePath` wins.
    // Ties break on shortest overall path (closer to vault root).
    const sourceDir = path.dirname(currentNotePath).replace(/\\/g, "/");
    candidates.sort((a, b) => {
      const da = sharedPathDepth(sourceDir, path.dirname(a).replace(/\\/g, "/"));
      const db = sharedPathDepth(sourceDir, path.dirname(b).replace(/\\/g, "/"));
      if (da !== db) return db - da;
      return a.length - b.length;
    });
    return candidates[0];
  }

  // 4. Alias fallback — Obsidian resolves `[[Display Name]]` to the note
  // whose frontmatter declares that alias when no filename matches.
  const aliasMap = options.aliasMap;
  if (aliasMap) {
    const hit = aliasMap.get(normalizedLinkLower);
    if (hit) return hit;
  }

  return null;
}
