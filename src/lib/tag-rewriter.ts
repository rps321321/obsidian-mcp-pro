import matter from "gray-matter";

/**
 * Tag rewriting across the two places Obsidian recognizes tags:
 *   1. Inline `#tag` tokens in the body
 *   2. The `tags:` (or `Tags:`/`tag:`) field in YAML frontmatter
 *
 * Hierarchical mode also rewrites nested tags: renaming `project` → `client`
 * with hierarchical=true also rewrites `project/alpha` → `client/alpha`.
 *
 * Renaming preserves surrounding whitespace, code-block exclusions, and the
 * frontmatter representation (array, comma-string, single-string).
 */

// Same character class as `extractTags` in markdown.ts so we don't accept
// renames the parser wouldn't see. Anchored to start-of-line or whitespace
// so `#anchor` inside a heading isn't matched as a tag.
const TAG_CHAR = "[a-zA-Z0-9\\u00C0-\\u024F\\u0400-\\u04FF\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF_/-]";
const TAG_HEAD = "[a-zA-Z\\u00C0-\\u024F\\u0400-\\u04FF\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF_]";
const INLINE_TAG_RE = new RegExp(`(^|\\s)#(${TAG_HEAD}${TAG_CHAR}*)`, "g");

interface FenceState {
  insideFence: boolean;
  char: string;
  len: number;
}
function newFence(): FenceState { return { insideFence: false, char: "", len: 0 }; }
function fenceTransition(state: FenceState, line: string): boolean {
  const trimmed = line.trimStart();
  if (state.insideFence) {
    const close = new RegExp(
      `^${state.char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{${state.len},}\\s*$`,
    );
    if (close.test(trimmed)) {
      state.insideFence = false;
      state.char = "";
      state.len = 0;
    }
    return true;
  }
  const m = trimmed.match(/^(`{3,}|~{3,})/);
  if (m) {
    state.insideFence = true;
    state.char = m[1][0];
    state.len = m[1].length;
    return true;
  }
  return false;
}

function stripInlineCode(line: string): { stripped: string; mask: boolean[] } {
  // Build a mask flagging which characters lie inside backtick-delimited
  // inline code spans. We don't strip the bytes — the rewriter does in-place
  // substitution and needs original offsets — but the mask lets it skip
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
      // Unclosed run — skip the opener and keep scanning.
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
    INLINE_TAG_RE.lastIndex = 0;
    let result = "";
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_TAG_RE.exec(line)) !== null) {
      const leading = m[1];
      const matchedTag = m[2];
      const tagStart = m.index + leading.length;
      // Skip if the `#` (one byte before tag start) is inside inline code.
      if (mask[tagStart] || mask[m.index]) continue;
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
 * Rewrite the frontmatter `tags`/`Tags`/`tag` field in place. Returns the
 * new content and a count. Preserves the field's representation: arrays
 * remain arrays; comma-delimited strings remain strings.
 */
export function rewriteFrontmatterTags(
  content: string,
  opts: TagMatchOptions,
): { content: string; count: number } {
  let parsed;
  try {
    parsed = matter(content);
  } catch {
    return { content, count: 0 };
  }
  const data = parsed.data as Record<string, unknown>;
  const candidateKeys = ["tags", "Tags", "TAGS", "tag", "Tag"];
  let count = 0;
  let dirty = false;
  for (const key of candidateKeys) {
    const value = data[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const next = value.map((item) => {
        if (typeof item !== "string") return item;
        const renamed = applyRename(item, opts);
        if (renamed !== null) {
          count++;
          dirty = true;
          return renamed;
        }
        return item;
      });
      if (dirty) data[key] = next;
    } else if (typeof value === "string") {
      const parts = value.split(",").map((s) => s.trim());
      let changed = false;
      const renamed = parts.map((part) => {
        const r = applyRename(part, opts);
        if (r !== null) { count++; changed = true; return r; }
        return part;
      });
      if (changed) {
        data[key] = renamed.join(", ");
        dirty = true;
      }
    }
  }
  if (!dirty) return { content, count: 0 };
  // matter.stringify returns the document with the rewritten frontmatter.
  return { content: matter.stringify(parsed.content, data), count };
}

/**
 * Apply both inline and frontmatter renames to a note's content.
 */
export function rewriteAllTags(
  content: string,
  opts: TagMatchOptions,
): { content: string; inlineCount: number; frontmatterCount: number } {
  const fmResult = rewriteFrontmatterTags(content, opts);
  // After rewriting frontmatter, re-parse to separate body and rewrite
  // inline tags in the body only — the frontmatter we already wrote shouldn't
  // be re-scanned by the inline regex.
  let parsed;
  try {
    parsed = matter(fmResult.content);
  } catch {
    return { content: fmResult.content, inlineCount: 0, frontmatterCount: fmResult.count };
  }
  const inline = rewriteInlineTags(parsed.content, opts);
  // Reassemble using the original frontmatter representation.
  const data = parsed.data as Record<string, unknown>;
  const reassembled = Object.keys(data).length > 0
    ? matter.stringify(inline.body, data)
    : inline.body;
  return {
    content: reassembled,
    inlineCount: inline.count,
    frontmatterCount: fmResult.count,
  };
}
