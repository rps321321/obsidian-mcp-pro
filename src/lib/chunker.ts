import { parseHeadings, type Heading } from "./sections.js";
import { parseFrontmatter } from "./markdown.js";

/**
 * Split a note's body into embedding-sized chunks.
 *
 * Strategy (in order, each step only fires if the previous left chunks too
 * large):
 *
 *   1. Strip frontmatter — it inflates token counts without semantic
 *      content for retrieval.
 *   2. Split on H2 / H3 headings, with each chunk including the heading
 *      hierarchy as a leading line so the embedded text stays
 *      self-describing ("# Project / ## Tasks / …").
 *   3. If a section is still too long, split by paragraph.
 *   4. If a paragraph is still too long, sliding-window on character count
 *      with overlap.
 *
 * The default 1500-character target is a comfortable fit for most
 * embedding models (nomic-embed-text accepts up to 8192 tokens; text-
 * embedding-3-small up to 8191; we leave headroom for the heading prefix
 * plus tokenizer overhead).
 */

const DEFAULT_TARGET_CHARS = 1500;
const DEFAULT_OVERLAP_CHARS = 200;

export interface Chunk {
  /** Heading-prefixed text body, ready to embed. */
  text: string;
  /** Heading path that led to this chunk, e.g. ["Project", "Tasks"].
   *  Empty for chunks that pre-date the first heading. */
  headingPath: string[];
  /** 1-indexed chunk number within the source note (for logging / display). */
  index: number;
}

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
}

/**
 * Top-level entry point. Returns at least one chunk for any non-empty note.
 */
export function chunkNote(content: string, options: ChunkOptions = {}): Chunk[] {
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  // Pull frontmatter out of the embedding text but keep title-ish keys
  // (title, aliases) on the front so notes without H1s still embed
  // something semantically meaningful.
  const { data, content: bodyAll } = parseFrontmatter(content);
  const titleParts: string[] = [];
  if (typeof data.title === "string" && data.title.trim()) titleParts.push(data.title.trim());
  if (Array.isArray(data.aliases)) {
    for (const a of data.aliases) {
      if (typeof a === "string" && a.trim()) titleParts.push(a.trim());
    }
  }
  const titlePrefix = titleParts.length > 0 ? `${titleParts.join(" / ")}\n\n` : "";

  const body = bodyAll.replace(/^\s+/, "");
  if (body.length === 0) return [];

  const sections = sliceByHeadings(body);
  const out: Chunk[] = [];
  let idx = 1;
  for (const sec of sections) {
    const prefix = sec.headingPath.length > 0
      ? `${titlePrefix}${sec.headingPath.join(" / ")}\n\n`
      : titlePrefix;
    if (sec.text.length + prefix.length <= targetChars) {
      out.push({
        text: prefix + sec.text,
        headingPath: sec.headingPath,
        index: idx++,
      });
      continue;
    }
    // Section too large — split further.
    const sub = splitOversized(sec.text, targetChars - prefix.length, overlapChars);
    for (const piece of sub) {
      out.push({
        text: prefix + piece,
        headingPath: sec.headingPath,
        index: idx++,
      });
    }
  }

  // Notes with zero headings produce a single section with empty path; if
  // even that came back empty (extremely short notes), embed the whole
  // file once as a fallback so the search can still surface them.
  if (out.length === 0) {
    out.push({ text: titlePrefix + body, headingPath: [], index: 1 });
  }
  return out;
}

/**
 * Walk the body once, returning section slices keyed by their open heading
 * path. Headings deeper than H3 are retained but don't trigger a split —
 * splitting on every nested heading produces too many tiny chunks.
 */
function sliceByHeadings(body: string): Array<{ text: string; headingPath: string[] }> {
  // Reuse the section parser by stitching frontmatter back on so its
  // bodyOffset detection is a no-op. (We've already stripped frontmatter,
  // so no offset adjustment is needed.)
  const headings = parseHeadings(body);
  if (headings.length === 0) {
    return [{ text: body.trim(), headingPath: [] }];
  }
  // Filter to splitting headings: H1, H2, H3.
  const splitters = headings.filter((h) => h.level <= 3);
  if (splitters.length === 0) {
    return [{ text: body.trim(), headingPath: [] }];
  }

  const out: Array<{ text: string; headingPath: string[] }> = [];
  // Preamble chunk: anything above the first splitting heading.
  const firstStart = splitters[0].lineStart;
  if (firstStart > 0) {
    const text = body.slice(0, firstStart).trim();
    if (text.length > 0) out.push({ text, headingPath: [] });
  }

  // Walk splitters and emit one chunk per splitter, ending at the next
  // splitter (regardless of relative depth — we want self-contained chunks
  // that don't bleed into siblings).
  const path: { level: number; text: string }[] = [];
  for (let i = 0; i < splitters.length; i++) {
    const h = splitters[i];
    while (path.length > 0 && path[path.length - 1].level >= h.level) path.pop();
    path.push({ level: h.level, text: h.text });

    const nextStart = i + 1 < splitters.length
      ? splitters[i + 1].lineStart
      : body.length;
    const sliceStart = headingLineEnd(body, h);
    const text = body.slice(sliceStart, nextStart).trim();
    if (text.length === 0) continue;
    out.push({ text, headingPath: path.map((p) => p.text) });
  }

  return out;
}

function headingLineEnd(_body: string, heading: Heading): number {
  return heading.lineEnd;
}

/**
 * Sliding-window split for sections that exceed the target chunk size.
 * Splits on paragraph boundaries when possible, falls back to fixed-size
 * windows otherwise. Successive windows overlap by `overlapChars` so
 * embeddings near a boundary still see surrounding context.
 */
function splitOversized(text: string, targetChars: number, overlapChars: number): string[] {
  const target = Math.max(200, targetChars);
  const overlap = Math.max(0, Math.min(overlapChars, Math.floor(target / 2)));
  const out: string[] = [];

  // First try paragraph-level splits.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let buffer = "";
  for (const para of paragraphs) {
    if (para.length > target) {
      // Flush buffer first, then character-window the giant paragraph.
      if (buffer) { out.push(buffer); buffer = ""; }
      for (let i = 0; i < para.length; i += target - overlap) {
        out.push(para.slice(i, Math.min(para.length, i + target)));
      }
      continue;
    }
    if (buffer.length + para.length + 2 > target) {
      if (buffer) out.push(buffer);
      buffer = para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}
