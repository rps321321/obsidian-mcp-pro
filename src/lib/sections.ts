/**
 * Heading / section / block-id parsing for markdown notes.
 *
 * "Section" here is the chunk of body content that follows an ATX heading
 * (`# foo`, `## bar`, …) up to the next heading at the same or shallower depth
 * — Obsidian's mental model. Frontmatter is excluded from section bounds: a
 * leading `---\n…\n---` block is treated as preamble belonging to no heading.
 *
 * "Block" here is a paragraph-or-block tagged with a trailing `^id` anchor,
 * which Obsidian uses for block-level transclusion (`![[note#^id]]`).
 *
 * All offsets returned are byte offsets into the input string. `start` is
 * inclusive; `end` is exclusive.
 */

export interface Heading {
  /** Depth: 1-6 for `#` through `######`. */
  level: number;
  /** Heading text with the `#` markers and trailing `#` decorations stripped. */
  text: string;
  /** Byte offset of the `#` at the start of the heading line. */
  lineStart: number;
  /** Byte offset just past the trailing newline (or content end). */
  lineEnd: number;
}

export interface Section {
  /** The heading that starts this section. */
  heading: Heading;
  /** Byte offset of the heading line (same as heading.lineStart). */
  start: number;
  /** Byte offset just past the section's last byte. Equals the start of the
   *  next sibling/ancestor heading, or the content length. */
  end: number;
  /** Byte offset just past the heading line — i.e. start of the body. */
  bodyStart: number;
}

interface FenceState {
  insideFence: boolean;
  fenceChar: string;
  fenceLength: number;
}

function newFenceState(): FenceState {
  return { insideFence: false, fenceChar: "", fenceLength: 0 };
}

function updateFence(state: FenceState, line: string): boolean {
  const trimmed = line.trimStart();
  if (state.insideFence) {
    const closePattern = new RegExp(
      `^${state.fenceChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{${state.fenceLength},}\\s*$`,
    );
    if (closePattern.test(trimmed)) {
      state.insideFence = false;
      state.fenceChar = "";
      state.fenceLength = 0;
    }
    return true;
  }
  const m = trimmed.match(/^(`{3,}|~{3,})/);
  if (m) {
    state.insideFence = true;
    state.fenceChar = m[1][0];
    state.fenceLength = m[1].length;
    return true;
  }
  return false;
}

const ATX_HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;

/**
 * Strip a leading frontmatter block (`---\n…\n---`) and return the byte
 * offset where the body begins. If no well-formed frontmatter is present,
 * returns 0.
 */
export function bodyOffset(content: string): number {
  if (!content.startsWith("---")) return 0;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return 0;
  const opener = content.slice(0, firstNewline + 1).replace(/\r?\n$/, "");
  if (opener !== "---") return 0;
  let offset = firstNewline + 1;
  let lines = 0;
  while (offset < content.length) {
    if (lines > 1024) return 0;
    const nl = content.indexOf("\n", offset);
    const lineEnd = nl === -1 ? content.length : nl;
    const line = content.slice(offset, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return nl === -1 ? content.length : nl + 1;
    }
    if (nl === -1) return 0;
    offset = nl + 1;
    lines++;
  }
  return 0;
}

/**
 * Parse all ATX headings in `content`, skipping fenced code blocks. Frontmatter
 * is excluded automatically.
 */
export function parseHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  const start = bodyOffset(content);
  const fence = newFenceState();
  let cursor = start;
  // Walk line-by-line preserving byte offsets.
  while (cursor < content.length) {
    const nl = content.indexOf("\n", cursor);
    const lineEnd = nl === -1 ? content.length : nl;
    const line = content.slice(cursor, lineEnd);
    const lineEndExclusive = nl === -1 ? content.length : nl + 1;

    const isFenceLine = updateFence(fence, line);
    if (!isFenceLine && !fence.insideFence) {
      const m = line.match(ATX_HEADING_RE);
      if (m) {
        out.push({
          level: m[1].length,
          text: m[2].trim(),
          lineStart: cursor,
          lineEnd: lineEndExclusive,
        });
      }
    }
    cursor = lineEndExclusive;
    if (nl === -1) break;
  }
  return out;
}

function normalizeHeadingText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find the section identified by a path of heading names (e.g.
 * `["Daily Notes", "2026-05-06"]`). The first element matches a top-level
 * heading; each subsequent element matches a heading nested under the
 * previous match. Comparison is case-insensitive and whitespace-tolerant.
 *
 * Single-element paths fall back to "first matching heading at any depth"
 * so common usage like `findSection(content, ["Tasks"])` works without
 * forcing the caller to know the heading depth.
 */
export function findSection(content: string, headingPath: readonly string[]): Section | null {
  if (headingPath.length === 0) return null;
  const headings = parseHeadings(content);
  if (headings.length === 0) return null;
  const targets = headingPath.map(normalizeHeadingText);

  // Walk linearly. Track the "open path" of headings as we go.
  const openPath: { level: number; index: number }[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    while (openPath.length > 0 && openPath[openPath.length - 1].level >= h.level) {
      openPath.pop();
    }
    openPath.push({ level: h.level, index: i });

    if (openPath.length < targets.length) continue;

    // Compare the last `targets.length` opened headings (ancestor-first) to
    // the requested path. Allows the path to begin at any depth — this is
    // the behavior most users expect, and matches single-element fallback
    // automatically.
    const slice = openPath.slice(openPath.length - targets.length);
    let match = true;
    for (let k = 0; k < targets.length; k++) {
      if (normalizeHeadingText(headings[slice[k].index].text) !== targets[k]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    return buildSection(content, headings, i);
  }
  return null;
}

/**
 * Build a Section spanning the heading at index `i` up to the next heading
 * (at ANY depth) or end-of-content. This matches Obsidian's section-body
 * model: a child heading like `## Tasks` ends the body of `# Project` so
 * `update_section("Project", …)` rewrites just the prose under `Project`,
 * not the entire descendant tree. Callers that want the full subtree can
 * concatenate adjacent sibling sections themselves.
 */
function buildSection(content: string, headings: readonly Heading[], i: number): Section {
  const head = headings[i];
  const end = i + 1 < headings.length ? headings[i + 1].lineStart : content.length;
  return {
    heading: head,
    start: head.lineStart,
    end,
    bodyStart: head.lineEnd,
  };
}

/**
 * Replace a section's body (everything between the heading line and the next
 * sibling/ancestor heading) with `newBody`. The heading line itself is
 * preserved. `newBody` is inserted verbatim with a single trailing newline
 * normalization so the next heading still starts on its own line.
 */
export function replaceSectionBody(
  content: string,
  section: Section,
  newBody: string,
): string {
  const before = content.slice(0, section.bodyStart);
  const after = content.slice(section.end);
  let body = newBody;
  if (!body.endsWith("\n")) body += "\n";
  // Avoid a stray blank line if the new body starts with one and the heading
  // already ends with a newline.
  return before + body + after;
}

/**
 * Insert content immediately after a heading line, before any existing body.
 */
export function insertAfterHeading(
  content: string,
  section: Section,
  inserted: string,
): string {
  const before = content.slice(0, section.bodyStart);
  const after = content.slice(section.bodyStart);
  let payload = inserted;
  if (!payload.endsWith("\n")) payload += "\n";
  return before + payload + after;
}

export interface BlockSpan {
  /** Block id (without the leading `^`). */
  id: string;
  /** Byte offset of the block's first line. */
  start: number;
  /** Byte offset just past the block's terminating newline. */
  end: number;
  /** Byte offset just past the block content (excluding the trailing
   *  blank-line separator if any). */
  contentEnd: number;
}

const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;

/**
 * Locate a block tagged with `^id`. Obsidian's convention: the `^id` token
 * sits at the end of a line, and the block extends backward to the previous
 * blank line (or document start). Lines inside fenced code blocks — including
 * the fence delimiters themselves — are not eligible for either matching the
 * `^id` token or extending the block backward.
 */
export function findBlockById(content: string, id: string): BlockSpan | null {
  const target = id.trim();
  if (!target) return null;

  // Walk lines and remember offsets so we can extend backward.
  const lines: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const nl = content.indexOf("\n", cursor);
    const lineEnd = nl === -1 ? content.length : nl;
    const text = content.slice(cursor, lineEnd);
    lines.push({ start: cursor, end: nl === -1 ? content.length : nl + 1, text });
    cursor = nl === -1 ? content.length : nl + 1;
    if (nl === -1) break;
  }

  // Pre-compute which lines are inside (or part of) a fenced code block.
  // The fence delimiter lines themselves count as fenced for the purpose of
  // block-extension boundaries: a `^id` block must not span across them.
  const fenced = new Array<boolean>(lines.length).fill(false);
  const fence = newFenceState();
  for (let i = 0; i < lines.length; i++) {
    const wasInside = fence.insideFence;
    const isFenceLine = updateFence(fence, lines[i].text);
    fenced[i] = wasInside || isFenceLine || fence.insideFence;
  }

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = lines[i].text.match(BLOCK_ID_RE);
    if (!m || m[1] !== target) continue;
    // Walk backward until we hit a blank line, a fenced line, or doc start.
    let blockStart = i;
    for (let k = i - 1; k >= 0; k--) {
      if (lines[k].text.trim() === "") break;
      if (fenced[k]) break;
      blockStart = k;
    }
    return {
      id: target,
      start: lines[blockStart].start,
      end: lines[i].end,
      contentEnd: lines[i].end,
    };
  }
  return null;
}

/**
 * Strip the trailing `^id` token from a line so the block content is shown
 * without its anchor. Useful for read-side fragment retrieval.
 */
export function stripBlockId(content: string): string {
  return content.replace(BLOCK_ID_RE, "");
}
