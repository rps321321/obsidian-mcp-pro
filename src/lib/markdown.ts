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
 * Track whether a line is inside a code block. Recognizes both fenced blocks
 * (triple-backtick / triple-tilde) and CommonMark indented code blocks
 * (4-space or tab leader, after a blank line). Returns a function that, given
 * a line, returns true if the line should be skipped.
 *
 * Indented-code detection follows the CommonMark rule that an indented code
 * block cannot interrupt a paragraph, so a line indented by 4 spaces only
 * counts as code when the previous line was blank (or another indented-code
 * line, or document start). False positives — e.g. a 4-space-indented list
 * continuation paragraph — are accepted: the link rewriter would rather miss
 * a rewrite than corrupt code.
 */
function createCodeBlockTracker(): (line: string) => boolean {
  let insideFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let insideIndentedCode = false;
  let prevWasBlank = true; // doc start qualifies for "after blank line" rule
  return (line: string): boolean => {
    if (insideFence) {
      const closePattern = new RegExp(
        `^${fenceChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{${fenceLength},}\\s*$`,
      );
      if (closePattern.test(line.trimStart())) {
        insideFence = false;
      }
      prevWasBlank = false;
      return true;
    }
    const trimmed = line.trimStart();
    const backtickMatch = trimmed.match(/^(`{3,})/);
    const tildeMatch = trimmed.match(/^(~{3,})/);
    if (backtickMatch) {
      insideFence = true;
      fenceChar = "`";
      fenceLength = backtickMatch[1].length;
      insideIndentedCode = false;
      prevWasBlank = false;
      return true;
    }
    if (tildeMatch) {
      insideFence = true;
      fenceChar = "~";
      fenceLength = tildeMatch[1].length;
      insideIndentedCode = false;
      prevWasBlank = false;
      return true;
    }
    if (line.trim() === "") {
      // Blank lines don't carry text to skip but they do permit the next
      // indented line to start (or continue) an indented code block.
      prevWasBlank = true;
      return false;
    }
    const indented = /^( {4}|\t)/.test(line);
    if (indented && (insideIndentedCode || prevWasBlank)) {
      insideIndentedCode = true;
      prevWasBlank = false;
      return true;
    }
    if (!indented) {
      insideIndentedCode = false;
    }
    prevWasBlank = false;
    return false;
  };
}

/**
 * Strip inline code spans from a line so patterns inside them are ignored.
 * Handles N-backtick spans (e.g. `` ``with ` inside`` ``), not just single
 * backticks.
 */
function stripInlineCode(line: string): string {
  const ranges = findInlineCodeRanges(line);
  if (ranges.length === 0) return line;
  let out = "";
  let cursor = 0;
  for (const [s, e] of ranges) {
    out += line.slice(cursor, s);
    cursor = e;
  }
  out += line.slice(cursor);
  return out;
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
 * Locate inline-code spans within a single line. Handles N-backtick spans
 * (CommonMark): an opening run of N backticks pairs with the next run of
 * exactly N backticks, allowing shorter runs to appear inside (e.g.
 * `` ``contains ` inside`` ``). Returned ranges are half-open `[start, end)`
 * byte offsets into the input. Used by the rewriter to skip matches that
 * fall inside inline code while preserving original offsets.
 */
function findInlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let openLen = 0;
    while (i + openLen < line.length && line[i + openLen] === "`") openLen++;
    let j = i + openLen;
    let matched = false;
    while (j < line.length) {
      if (line[j] !== "`") {
        j++;
        continue;
      }
      let closeLen = 0;
      while (j + closeLen < line.length && line[j + closeLen] === "`") closeLen++;
      if (closeLen === openLen) {
        ranges.push([i, j + closeLen]);
        i = j + closeLen;
        matched = true;
        break;
      }
      j += closeLen;
    }
    if (!matched) {
      // Unclosed run: advance past the opener and keep scanning. Rare in
      // practice; matches the lenient behavior of the previous regex.
      i += openLen;
    }
  }
  return ranges;
}

function isInRanges(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true;
  }
  return false;
}

/**
 * A wikilink occurrence with original offsets and the inner pieces split out.
 * Used by the link rewriter to do precise in-place substitution.
 */
export interface WikilinkSpan {
  /** Byte offset where the leading `!` (or `[[`) begins. */
  start: number;
  /** Byte offset just past the closing `]]`. */
  end: number;
  /** Whether this is an `![[...]]` embed. */
  isEmbed: boolean;
  /** Target portion before any `|` or `#` (whitespace trimmed). */
  target: string;
  /** Heading or block-id fragment with leading `#`, or `""` if absent. */
  fragment: string;
  /** Display text after `|`, or `undefined` if none. */
  alias?: string;
}

/**
 * Extract every wikilink in `content` with original byte offsets, skipping
 * fenced code blocks and inline code. Use when you need to rewrite a
 * wikilink in place. For analysis only, prefer `extractWikilinks`.
 */
export function extractWikilinkSpans(content: string): WikilinkSpan[] {
  const out: WikilinkSpan[] = [];
  const isInsideCodeBlock = createCodeBlockTracker();
  const wikilinkRegex = /(!)?\[\[([^\]\n]+?)\]\]/g;

  let lineStart = 0;
  for (const line of content.split("\n")) {
    if (!isInsideCodeBlock(line)) {
      const inlineRanges = findInlineCodeRanges(line);
      wikilinkRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = wikilinkRegex.exec(line)) !== null) {
        const matchStart = m.index;
        if (isInRanges(matchStart, inlineRanges)) continue;

        const isEmbed = m[1] === "!";
        const inner = m[2];
        const pipeIndex = inner.indexOf("|");
        const before = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
        const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : undefined;
        const hashIndex = before.indexOf("#");
        const target = (hashIndex >= 0 ? before.slice(0, hashIndex) : before).trim();
        const fragment = hashIndex >= 0 ? before.slice(hashIndex) : "";

        out.push({
          start: lineStart + matchStart,
          end: lineStart + matchStart + m[0].length,
          isEmbed,
          target,
          fragment,
          alias,
        });
      }
    }
    lineStart += line.length + 1; // +1 for the consumed "\n"
  }
  return out;
}

/**
 * A markdown link occurrence with original offsets. Matches `[text](url)`
 * (and the embed variant `![text](url)`). The URL is split into path + fragment
 * so the rewriter can substitute the path while preserving `#heading` and any
 * trailing title attribute.
 */
export interface MarkdownLinkSpan {
  start: number;
  end: number;
  isEmbed: boolean;
  /** Display text inside `[...]`. */
  text: string;
  /** URL path portion before any `#` fragment. */
  urlPath: string;
  /** Fragment beginning with `#`, or `""` if absent. */
  fragment: string;
  /** Trailing ` "title"` portion of the link, including leading space, or `""`. */
  title: string;
}

/**
 * Extract every markdown `[text](url)` link in `content` with original byte
 * offsets. Skips fenced code blocks and inline code. Used by the link
 * rewriter so vault reorganizations update plain markdown links alongside
 * wikilinks.
 */
export function extractMarkdownLinkSpans(content: string): MarkdownLinkSpan[] {
  const out: MarkdownLinkSpan[] = [];
  const isInsideCodeBlock = createCodeBlockTracker();
  // Permit a `!` embed prefix, then `[text](url)`. URLs without spaces; an
  // optional ` "title"` suffix is captured separately. Bare `()` aren't
  // supported in URLs (Obsidian itself encodes them) — keeping the URL char
  // class strict avoids over-matching paragraph parens.
  const re = /(!)?\[([^\]\n]*)\]\(([^\s)]+)(\s+"[^"\n]*")?\)/g;

  let lineStart = 0;
  for (const line of content.split("\n")) {
    if (!isInsideCodeBlock(line)) {
      const inlineRanges = findInlineCodeRanges(line);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const matchStart = m.index;
        if (isInRanges(matchStart, inlineRanges)) continue;

        const isEmbed = m[1] === "!";
        const text = m[2];
        const url = m[3];
        const title = m[4] ?? "";
        const hashIndex = url.indexOf("#");
        const urlPath = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
        const fragment = hashIndex >= 0 ? url.slice(hashIndex) : "";

        out.push({
          start: lineStart + matchStart,
          end: lineStart + matchStart + m[0].length,
          isEmbed,
          text,
          urlPath,
          fragment,
          title,
        });
      }
    }
    lineStart += line.length + 1;
  }
  return out;
}

/**
 * Pick the wikilink target string for `newPath` that best preserves the
 * `originalForm` the author wrote. If they used a basename and that basename
 * is still unambiguous after the move, keep the basename; otherwise fall back
 * to the path-without-extension form. Path-form originals always become
 * the new path-without-extension.
 *
 * `allNotes` is the post-move list (must contain `newPath`).
 */
export function formatWikilinkTarget(
  newPath: string,
  originalForm: string,
  allNotes: readonly string[],
): string {
  const newWithoutExt = newPath.replace(/\.md$/i, "");
  const originalUsedPath = originalForm.includes("/");
  if (originalUsedPath) return newWithoutExt;

  const newBasename = path.basename(newWithoutExt);
  const newBasenameLower = newBasename.toLowerCase();
  let collisions = 0;
  for (const np of allNotes) {
    const base = path.basename(np, path.extname(np)).toLowerCase();
    if (base === newBasenameLower) {
      collisions++;
      if (collisions > 1) break;
    }
  }
  return collisions <= 1 ? newBasename : newWithoutExt;
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
