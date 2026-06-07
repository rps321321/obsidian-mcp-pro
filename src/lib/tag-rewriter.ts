import {
  parseStrictYamlFrontmatter,
  stringifyYamlFrontmatter,
} from "./markdown.js";

/**
 * Tag rewriting across the two places Obsidian recognizes tags:
 *   1. Inline `#tag` tokens in the body
 *   2. The `tags:` (or `Tags:`/`tag:`) field in YAML frontmatter
 *
 * Hierarchical mode also rewrites nested tags: renaming `project` -> `client`
 * with hierarchical=true also rewrites `project/alpha` -> `client/alpha`.
 *
 * Renaming preserves surrounding whitespace, code-block exclusions, and the
 * frontmatter representation (array, comma-string, single-string).
 */

// Same character class as `extractTags` in markdown.ts so we don't accept
// renames the parser wouldn't see. Anchored to start-of-line or whitespace
// so `#anchor` inside a heading isn't matched as a tag.
const TAG_CHAR = "[a-zA-Z0-9\\u00C0-\\u024F\\u0400-\\u04FF\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF_/-]";
const TAG_HEAD = "[a-zA-Z0-9\\u00C0-\\u024F\\u0400-\\u04FF\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF_]";
const TAG_NAME_RE = new RegExp(`^${TAG_HEAD}${TAG_CHAR}*$`);

export function isValidTagName(name: string): boolean {
  return TAG_NAME_RE.test(name) && /[^\d/]/u.test(name);
}

interface FenceState {
  insideFence: boolean;
  char: string;
  len: number;
  closeRe: RegExp | null;
}
function newFence(): FenceState {
  return { insideFence: false, char: "", len: 0, closeRe: null };
}
function fenceTransition(state: FenceState, line: string): boolean {
  // Per CommonMark 4.5, both opening and closing fences accept at most
  // 3 leading spaces. A 4-space-indented run of backticks is part of an
  // indented code block, not a fence delimiter. The previous implementation
  // used `line.trimStart()` which accepted arbitrary indentation, so a
  // deeply-indented ``` would prematurely open/close a fence.
  if (state.insideFence) {
    // The close regex is compiled once when the fence opens and reused
    // for every interior line, avoiding per-line RegExp allocation.
    if (state.closeRe !== null && state.closeRe.test(line)) {
      state.insideFence = false;
      state.char = "";
      state.len = 0;
      state.closeRe = null;
    }
    return true;
  }
  const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (m) {
    state.insideFence = true;
    state.char = m[1]![0]!;
    state.len = m[1]!.length;
    const escaped = state.char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    state.closeRe = new RegExp(`^ {0,3}${escaped}{${state.len},}\\s*$`);
    return true;
  }
  return false;
}

function stripInlineCode(line: string): { stripped: string; mask: boolean[] } {
  // Build a mask flagging which characters lie inside backtick-delimited
  // inline code spans. We don't strip the bytes - the rewriter does in-place
  // substitution and needs original offsets - but the mask lets it skip
  // matches that fall inside code. Mirrors `findInlineCodeRanges` semantics.
  const mask = new Array<boolean>(line.length).fill(false);
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") { i++; continue; }
    let openLen = 0;
    while (i + openLen < line.length && line[i + openLen] === "`") openLen++;
    let j = i + openLen;
    while (j < line.length) {
      if (line[j] !== "`") { j++; continue; }
      let closeLen = 0;
      while (j + closeLen < line.length && line[j + closeLen] === "`") closeLen++;
      if (closeLen === openLen) {
        for (let k = i; k < j + closeLen; k++) mask[k] = true;
        i = j + closeLen;
        break;
      }
      j += closeLen;
    }
    if (j >= line.length) {
      // Unclosed run - skip the opener and keep scanning.
      i += openLen;
    }
  }
  return { stripped: line, mask };
}

interface TagMatchOptions {
  oldName: string;
  newName: string;
  hierarchical: boolean;
}

function applyRename(matched: string, opts: TagMatchOptions): string | null {
  const { oldName, newName, hierarchical } = opts;
  if (matched === oldName) return newName;
  if (hierarchical && matched.startsWith(oldName + "/")) {
    return newName + matched.slice(oldName.length);
  }
  return null;
}

/**
 * Rewrite inline tags in the body. Returns the new body and the count of
 * substitutions made. Skips fenced code blocks and inline code spans, and
 * skips ATX heading lines so `# Heading` never gets confused for a tag.
 */
export function rewriteInlineTags(
  body: string,
  opts: TagMatchOptions,
): { body: string; count: number } {
  // Local regex so each invocation gets a fresh lastIndex. Module-level
  // /g regexes carry state between calls, which is a latent footgun.
  const inlineTagRe = new RegExp(`(^|\\s)#(${TAG_HEAD}${TAG_CHAR}*)`, "g");
  const fence = newFence();
  const out: string[] = [];
  let count = 0;
  const lines = body.split("\n");
  for (const line of lines) {
    const fenceLine = fenceTransition(fence, line);
    if (fenceLine || fence.insideFence) {
      out.push(line);
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      out.push(line);
      continue;
    }
    const { mask } = stripInlineCode(line);
    inlineTagRe.lastIndex = 0;
    let result = "";
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineTagRe.exec(line)) !== null) {
      const leading = m[1]!;
      const matchedTag = m[2]!;
      const tagStart = m.index + leading.length;
      // Skip if the `#` (one byte before tag start) is inside inline code.
      if (mask[tagStart] || mask[m.index]) continue;
      if (!isValidTagName(matchedTag)) continue;
      const renamed = applyRename(matchedTag, opts);
      if (renamed === null) continue;
      result += line.slice(cursor, tagStart);
      result += "#" + renamed;
      cursor = tagStart + 1 + matchedTag.length;
      count++;
    }
    result += line.slice(cursor);
    out.push(result);
  }
  return { body: out.join("\n"), count };
}

/**
 * Rewrite tag values in a parsed frontmatter data object. Mutates `data`
 * in place when entries match. Returns the number of renames.
 */
function rewriteFrontmatterData(
  data: Record<string, unknown>,
  opts: TagMatchOptions,
): number {
  const candidateKeys = ["tags", "Tags", "TAGS", "tag", "Tag"];
  let count = 0;
  for (const key of candidateKeys) {
    const value = data[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      let keyChanged = false;
      const items = value as unknown[];
      const next = items.map((item): unknown => {
        if (typeof item !== "string") return item;
        const renamed = applyRename(item, opts);
        if (renamed !== null) {
          count++;
          keyChanged = true;
          return renamed;
        }
        return item;
      });
      if (keyChanged) data[key] = next;
    } else if (typeof value === "string") {
      const parts = value.split(",").map((s) => s.trim());
      let changed = false;
      const renamed = parts.map((part) => {
        const r = applyRename(part, opts);
        if (r !== null) { count++; changed = true; return r; }
        return part;
      });
      if (changed) data[key] = renamed.join(", ");
    }
  }
  return count;
}

/**
 * Rewrite the frontmatter `tags`/`Tags`/`tag` field in place. Returns the
 * new content and a count. Preserves the field's representation: arrays
 * remain arrays; comma-delimited strings remain strings.
 */
export function rewriteFrontmatterTags(
  content: string,
  opts: TagMatchOptions,
): { content: string; count: number } {
  const parsed = parseStrictYamlFrontmatter(content);
  if (!parsed.hasFrontmatter || parsed.error || parsed.oversized) {
    return { content, count: 0 };
  }
  const data = parsed.data;
  const count = rewriteFrontmatterData(data, opts);
  if (count === 0) return { content, count: 0 };
  return { content: stringifyYamlFrontmatter(parsed.content, data), count };
}

/**
 * Apply both inline and frontmatter renames to a note's content.
 *
 * Single round-trip through gray-matter: parse once, rewrite the
 * frontmatter data object and the body independently, then emit once.
 * Re-parsing the matter.stringify output between steps risks accumulating
 * blank lines between the frontmatter fence and the body (gray-matter
 * preserves leading whitespace in parsed.content while matter.stringify
 * also inserts its own separator).
 */
export function rewriteAllTags(
  content: string,
  opts: TagMatchOptions,
): { content: string; inlineCount: number; frontmatterCount: number } {
  const parsed = parseStrictYamlFrontmatter(content);
  if (parsed.error || parsed.oversized) {
    // Malformed YAML: fall back to inline-only rewriting on the raw content.
    const inline = rewriteInlineTags(content, opts);
    return { content: inline.body, inlineCount: inline.count, frontmatterCount: 0 };
  }
  // Detect whether the original content had frontmatter before we mutate
  // the data object. This way we preserve the `---\n---\n` delimiters even
  // if tag removal empties the frontmatter entirely (BUG-5 fix).
  const hadFrontmatter = parsed.hasFrontmatter;
  const data = parsed.data;
  const frontmatterCount = rewriteFrontmatterData(data, opts);
  const inline = rewriteInlineTags(parsed.content, opts);
  const hasFrontmatter = Object.keys(data).length > 0;
  let reassembled: string;
  if (hasFrontmatter) {
    reassembled = stringifyYamlFrontmatter(inline.body, data);
  } else if (hadFrontmatter) {
    // Frontmatter was present but is now empty after tag removal;
    // preserve the empty delimiters so downstream tools still see a
    // frontmatter block.
    reassembled = `---\n---\n${inline.body}`;
  } else {
    reassembled = inline.body;
  }
  return {
    content: reassembled,
    inlineCount: inline.count,
    frontmatterCount,
  };
}
