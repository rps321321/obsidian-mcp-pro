import path from "path";
import fs from "fs/promises";
import {
  resolveVaultPathSafe,
  readVaultTextFile,
  withFileLock,
  atomicWriteFile,
  assertNoteFileSize,
  CASE_INSENSITIVE_FS,
} from "./vault-fs.js";
import { readNote } from "./note-reads.js";
import {
  listCanvasFiles,
  readCanvasFile,
  MAX_CANVAS_FILE_BYTES,
} from "./canvas.js";
import {
  extractAliases,
  extractWikilinkSpans,
  extractMarkdownLinkSpans,
  formatWikilinkTarget,
  resolveWikilink,
} from "./markdown.js";
import { mapConcurrent } from "./concurrency.js";
import { log } from "./logger.js";
import type { CanvasData } from "../types.js";

const SCAN_CONCURRENCY = 8;

function assertCanvasApplyFileSize(relativePath: string, size: number): void {
  if (size > MAX_CANVAS_FILE_BYTES) {
    throw new Error(
      `Canvas file exceeds size cap (${size} > ${MAX_CANVAS_FILE_BYTES} bytes): ${relativePath}`
    );
  }
}

function assertCanvasJsonObject(
  parsed: unknown,
  relativePath: string
): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid canvas file (expected JSON object): ${relativePath}`
    );
  }
  return parsed as Record<string, unknown>;
}

function isExternalMarkdownUrl(url: string): boolean {
  return url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function sameMovePath(left: string, right: string): boolean {
  return CASE_INSENSITIVE_FS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** A single in-place edit on a referrer file, expressed as a byte-offset slice
 *  to replace. Edits within a file are listed in increasing-offset order.
 *
 *  `expected` captures the exact bytes at `[start, end)` at plan time. The
 *  apply step compares against current contents so a parallel `write_note`
 *  that mutated the referrer between plan and apply (offsets shift but
 *  bounds still pass) doesn't silently splice the wrong bytes. */
interface SpanEdit {
  start: number;
  end: number;
  expected: string;
  replacement: string;
}

/** A complete plan of edits across all referrer files. Canvas edits are
 *  represented separately because they're applied via JSON re-serialization
 *  rather than offset substitution. */
export interface RewritePlan {
  /** Markdown file edits keyed by vault-relative path. Empty map = no work. */
  notes: Map<string, SpanEdit[]>;
  /** Canvas files that need their `nodes[].file` field updated. */
  canvases: string[];
  /** Old vault-relative path being moved (with `.md` extension). */
  oldPath: string;
  /** New vault-relative path being moved to (with `.md` extension). */
  newPath: string;
}

export interface ApplyResult {
  /** Vault-relative paths whose contents were rewritten. */
  updated: string[];
  /** Per-file failures encountered during apply; rename has already committed
   *  by the time this runs, so partial failures are surfaced rather than
   *  rolled back. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Build an edit plan describing how to update every reference to `oldPath`
 * across the vault so it points at `newPath` instead. Pure planning — does
 * not write to disk. Caller is expected to invoke `applyRewrites` after the
 * rename has committed.
 *
 * `preMoveNotes` is the list returned by `listNotes(vaultPath)` *before* the
 * rename. Resolution is computed against this list so a wikilink that pointed
 * at the moved file is correctly identified, even if a different note
 * elsewhere happens to share its basename.
 */
export async function planMoveRewrites(
  vaultPath: string,
  oldPath: string,
  newPath: string,
  preMoveNotes: string[]
): Promise<RewritePlan> {
  oldPath = path.posix.normalize(oldPath.replace(/\\/g, "/"));
  newPath = path.posix.normalize(newPath.replace(/\\/g, "/"));
  if (CASE_INSENSITIVE_FS) {
    oldPath = preMoveNotes.find((note) => sameMovePath(note, oldPath)) ?? oldPath;
  }
  // Build the post-move note set by substituting old → new. Used for picking
  // the output form (basename vs path) that matches Obsidian's behavior.
  const postMoveNotes = preMoveNotes.map((n) => (n === oldPath ? newPath : n));

  // Single-pass note read. The previous implementation walked every note
  // twice (once to build the alias map, once to record edits), doubling
  // I/O on large vaults. We now load each note's content into a Map once
  // and reuse it for both the alias build and the edit-plan walk. The
  // alias build is synchronous in-memory, so it can complete before the
  // edit walk starts without a separate I/O pass.
  const contents = new Map<string, string>();
  await mapConcurrent(preMoveNotes, SCAN_CONCURRENCY, async (notePath) => {
    try {
      contents.set(notePath, await readNote(vaultPath, notePath));
    } catch (err) {
      log.warn("link-rewriter: read failed during plan", {
        note: notePath,
        err: err as Error,
      });
    }
    return undefined;
  });

  const aliasMap = new Map<string, string>();
  for (const [notePath, content] of contents) {
    for (const alias of extractAliases(content)) {
      const key = alias.toLowerCase();
      if (key) aliasMap.set(key, notePath);
    }
  }

  const notesPlan = new Map<string, SpanEdit[]>();
  const postMoveAliases = new Map(
    Array.from(aliasMap, ([alias, note]) => [alias, note === oldPath ? newPath : note])
  );

  for (const [notePath, content] of contents) {
    const outputPath = notePath === oldPath ? newPath : notePath;
    const edits: SpanEdit[] = [];

    // Wikilinks.
    for (const span of extractWikilinkSpans(content)) {
      if (!span.target) continue;
      const resolved = resolveWikilink(span.target, notePath, preMoveNotes, {
        aliasMap,
      });
      if (!resolved || (notePath !== oldPath && resolved !== oldPath)) continue;
      const destination = resolved === oldPath ? newPath : resolved;
      if (notePath === oldPath && resolveWikilink(span.target, outputPath, postMoveNotes, {
        aliasMap: postMoveAliases,
      }) === destination) continue;

      const newTarget = formatWikilinkTarget(
        destination,
        span.target,
        postMoveNotes
      );
      const aliasPart = span.alias !== undefined ? `|${span.alias}` : "";
      const replacement = `${span.isEmbed ? "!" : ""}[[${newTarget}${span.fragment}${aliasPart}]]`;
      // Skip no-op rewrites: a bare `[[idea]]` that resolves to the moved
      // note may already be in the right form when the basename stays
      // unambiguous post-move. Reporting these as "updated" would be
      // misleading and would touch mtimes for nothing.
      const expected = content.slice(span.start, span.end);
      if (replacement === expected) continue;
      edits.push({ start: span.start, end: span.end, expected, replacement });
    }

    // Markdown `[text](url)` links. Resolve URL paths the same way wikilinks
    // resolve, so `[x](inbox/idea.md)` and `[x](inbox/idea)` both rewrite.
    for (const span of extractMarkdownLinkSpans(content)) {
      const url = span.urlPath;
      // Skip absolute / external URLs — only intra-vault references rewrite.
      if (isExternalMarkdownUrl(url)) continue;
      const decoded = safeDecode(url);
      if (!decoded || isExternalMarkdownUrl(decoded)) continue;
      let newUrl: string;
      if (notePath === oldPath && isExplicitRelativePath(decoded)) {
        const target = path.posix.normalize(path.posix.join(referrerDir(notePath), decoded));
        if (target === ".." || target.startsWith("../")) continue;
        const destination = sameMovePath(target, oldPath) ? newPath :
          sameMovePath(target, oldPath.replace(/\.md$/i, "")) ? newPath.replace(/\.md$/i, "") : target;
        newUrl = encodeUrlPath(relativeMarkdownTarget(destination, outputPath, decoded));
      } else {
        const resolved = resolveMarkdownLinkPath(decoded, notePath, preMoveNotes, aliasMap);
        const attachment = notePath === oldPath || resolved === oldPath
          ? await existingMarkdownAttachment(vaultPath, decoded, notePath)
          : null;
        if (attachment) {
          if (notePath !== oldPath || !attachment.relative) continue;
          newUrl = encodeUrlPath(relativeMarkdownTarget(attachment.target, outputPath, decoded));
        } else {
          if (!resolved || (notePath !== oldPath && resolved !== oldPath)) continue;
          const destination = resolved === oldPath ? newPath : resolved;
          if (notePath === oldPath && resolveMarkdownLinkPath(decoded, outputPath, postMoveNotes, postMoveAliases) === destination) continue;
          const hadExt = /\.md$/i.test(decoded);
          const newBare = formatMarkdownLinkTarget(
            destination, decoded.replace(/\.md$/i, ""), outputPath, postMoveNotes
          );
          newUrl = encodeUrlPath(hadExt ? `${newBare}.md` : newBare);
        }
      }
      const replacement = `${span.isEmbed ? "!" : ""}[${span.text}](${newUrl}${span.fragment}${span.title})`;
      const expected = content.slice(span.start, span.end);
      if (replacement === expected) continue;
      edits.push({ start: span.start, end: span.end, expected, replacement });
    }

    if (edits.length > 0) {
      // Edits within a file may have been produced in interleaved order
      // (wikilinks then markdown links). Sort ascending so the apply step
      // can walk back-to-front cleanly.
      edits.sort((a, b) => a.start - b.start);
      notesPlan.set(outputPath, edits);
    }
  }

  // Canvas pass — `nodes[].file` is the structured equivalent of a wikilink,
  // and Obsidian stores the vault-relative path verbatim. Match by exact
  // (case-insensitive) path equality on the old path. Use mapConcurrent's
  // return value rather than a shared push-target so the array isn't
  // mutated from concurrent callbacks.
  const canvasPaths = await listCanvasFiles(vaultPath);
  const oldLower = oldPath.toLowerCase();
  const canvasMatches = await mapConcurrent<string, string | undefined>(
    canvasPaths,
    SCAN_CONCURRENCY,
    async (cp) => {
      let data: CanvasData;
      try {
        data = await readCanvasFile(vaultPath, cp);
      } catch (err) {
        log.warn("link-rewriter: canvas read failed during plan", {
          note: cp,
          err: err as Error,
        });
        return undefined;
      }
      for (const node of data.nodes) {
        if (
          typeof node.file === "string" &&
          node.file.toLowerCase() === oldLower
        ) {
          return cp;
        }
      }
      return undefined;
    }
  );
  const canvasesToRewrite: string[] = canvasMatches.filter(
    (c): c is string => typeof c === "string"
  );

  return {
    notes: notesPlan,
    canvases: canvasesToRewrite,
    oldPath,
    newPath,
  };
}

/**
 * Build an edit plan describing how to strip every reference to `deletedPath`
 * across the vault. Pure planning — does not write to disk. Caller is
 * expected to invoke `applyRewrites` after the deletion has committed.
 *
 * Replacement rules:
 *
 * - Wikilinks: `[[file]]` becomes the deleted file's basename (or alias if
 *   present). `![[file]]` (embed) is removed entirely since an embed has
 *   no fallback text. Fragments (`#heading`, `#^block`) are dropped — the
 *   target is gone, so the fragment is meaningless.
 * - Markdown links: `[text](file.md)` becomes the visible text. `![alt](...)`
 *   embed pointing at the deleted file is removed entirely.
 * - Canvas: not handled here. Cleaning canvas refs after delete is a
 *   separate decision (remove node? leave dangling? convert to text node?)
 *   tracked separately. The returned plan has `canvases: []`.
 *
 * `preDeleteNotes` is the list returned by `listNotes(vaultPath)` *before*
 * the delete. Resolution is computed against it so a wikilink that pointed
 * at the deleted file is correctly identified, even if a different note
 * elsewhere happens to share its basename.
 */
export async function planDeleteRewrites(
  vaultPath: string,
  deletedPath: string,
  preDeleteNotes: string[]
): Promise<RewritePlan> {
  // Single-pass note read — same I/O optimization as planMoveRewrites.
  const contents = new Map<string, string>();
  await mapConcurrent(preDeleteNotes, SCAN_CONCURRENCY, async (notePath) => {
    try {
      contents.set(notePath, await readNote(vaultPath, notePath));
    } catch (err) {
      log.warn("link-rewriter: read failed during delete plan", {
        note: notePath,
        err: err as Error,
      });
    }
    return undefined;
  });

  const aliasMap = new Map<string, string>();
  for (const [notePath, content] of contents) {
    for (const alias of extractAliases(content)) {
      const key = alias.toLowerCase();
      if (key) aliasMap.set(key, notePath);
    }
  }

  const notesPlan = new Map<string, SpanEdit[]>();

  // Fallback display text for wikilinks without an alias: the basename of
  // the deleted file, without extension or path. Matches what Obsidian would
  // render for a now-broken bare wikilink.
  const deletedBasename =
    deletedPath.replace(/\.md$/i, "").split("/").pop() ??
    deletedPath.replace(/\.md$/i, "");

  for (const [notePath, content] of contents) {
    // Skip the file being deleted itself — it's about to disappear, so
    // editing its body is wasted work (and the FS write would race the
    // unlink). The `removeReferences` path only edits *other* notes.
    if (notePath === deletedPath) continue;

    const edits: SpanEdit[] = [];

    // Wikilinks.
    for (const span of extractWikilinkSpans(content)) {
      if (!span.target) continue;
      const resolved = resolveWikilink(span.target, notePath, preDeleteNotes, {
        aliasMap,
      });
      if (resolved !== deletedPath) continue;

      // Embeds disappear entirely; plain wikilinks fall back to alias-or-basename.
      const replacement = span.isEmbed
        ? ""
        : span.alias !== undefined
          ? span.alias
          : deletedBasename;
      const expected = content.slice(span.start, span.end);
      if (replacement === expected) continue;
      edits.push({ start: span.start, end: span.end, expected, replacement });
    }

    // Markdown `[text](url)` links.
    for (const span of extractMarkdownLinkSpans(content)) {
      const url = span.urlPath;
      // Skip absolute / external URLs — only intra-vault refs strip.
      if (isExternalMarkdownUrl(url)) continue;
      const decoded = safeDecode(url);
      const resolved = resolveMarkdownLinkPath(
        decoded,
        notePath,
        preDeleteNotes,
        aliasMap
      );
      if (resolved !== deletedPath) continue;

      const replacement = span.isEmbed ? "" : span.text;
      const expected = content.slice(span.start, span.end);
      if (replacement === expected) continue;
      edits.push({ start: span.start, end: span.end, expected, replacement });
    }

    if (edits.length > 0) {
      edits.sort((a, b) => a.start - b.start);
      notesPlan.set(notePath, edits);
    }
  }

  return {
    notes: notesPlan,
    canvases: [],
    oldPath: deletedPath,
    newPath: "", // unused by applyRewrites when canvases is empty
  };
}

/**
 * Apply a previously-built `RewritePlan` to the vault. Each file is
 * serialized through the existing per-file lock so concurrent MCP writes
 * don't lose updates. Markdown edits are applied back-to-front to keep
 * earlier offsets valid.
 *
 * Failures are accumulated, not thrown — the rename has already committed
 * by the time we get here, so callers need to know which referrers landed
 * and which need a manual retry.
 */
export async function applyRewrites(
  vaultPath: string,
  plan: RewritePlan
): Promise<ApplyResult> {
  const updated: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Markdown pass.
  await mapConcurrent(
    Array.from(plan.notes.keys()),
    SCAN_CONCURRENCY,
    async (notePath) => {
      const edits = plan.notes.get(notePath);
      if (!edits || edits.length === 0) return undefined;
      try {
        const fullPath = await resolveVaultPathSafe(
          vaultPath,
          notePath,
          "write"
        );
        let didWrite = false;
        await withFileLock(fullPath, async () => {
          // Re-read inside the lock so we apply edits to current content.
          // applyEditsBackToFront verifies each edit's `expected` slice
          // matches before splicing — a parallel `write_note` that landed
          // between plan and apply will fail the comparison.
          const read = await readVaultTextFile(vaultPath, notePath, "write");
          assertNoteFileSize(notePath, read.stats.size);
          const current = read.content;
          let next = applyEditsBackToFront(current, edits);
          if (next === null) {
            // Single bounded retry: the offsets drifted because content
            // was added or removed elsewhere in the file (Obsidian sync,
            // text editor, concurrent rename_tag — anything that shifts
            // byte positions without touching the link itself). If every
            // edit's `expected` substring still appears exactly once in
            // the current content, we splice at the new positions. If
            // any expected slice is missing or ambiguous (>1 match), we
            // surface the failure rather than risk picking the wrong
            // occurrence.
            next = retryEditsByContent(current, edits);
          }
          if (next === null) {
            failed.push({
              path: notePath,
              error: "content changed during move; references not updated",
            });
            return;
          }
          if (next !== current) {
            assertNoteFileSize(notePath, Buffer.byteLength(next, "utf-8"));
            await atomicWriteFile(fullPath, next);
            didWrite = true;
          }
        });
        if (didWrite) updated.push(notePath);
      } catch (err) {
        failed.push({ path: notePath, error: (err as Error).message });
      }
      return undefined;
    }
  );

  // Canvas pass.
  for (const cp of plan.canvases) {
    try {
      const fullPath = await resolveVaultPathSafe(vaultPath, cp, "write");
      let didWrite = false;
      await withFileLock(fullPath, async () => {
        const read = await readVaultTextFile(vaultPath, cp, "write");
        assertCanvasApplyFileSize(cp, read.stats.size);
        const raw = read.content;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Invalid canvas file (malformed JSON): ${cp}`);
        }
        const obj = assertCanvasJsonObject(parsed, cp);
        const nodes = Array.isArray(obj.nodes)
          ? (obj.nodes as Array<Record<string, unknown>>)
          : [];
        let mutated = false;
        const oldLower = plan.oldPath.toLowerCase();
        for (const node of nodes) {
          if (
            typeof node.file === "string" &&
            node.file.toLowerCase() === oldLower
          ) {
            node.file = plan.newPath;
            mutated = true;
          }
        }
        if (mutated) {
          const serialized = JSON.stringify({ ...obj, nodes }, null, 2);
          assertCanvasApplyFileSize(cp, Buffer.byteLength(serialized, "utf-8"));
          await atomicWriteFile(fullPath, serialized);
          didWrite = true;
        }
      });
      if (didWrite) updated.push(cp);
    } catch (err) {
      failed.push({ path: cp, error: (err as Error).message });
    }
  }

  return { updated, failed };
}

/** Apply pre-sorted edits back-to-front. Returns `null` if any edit's span
 *  is out of bounds or if the bytes at `[start, end)` don't match the edit's
 *  `expected` slice — which means the file was modified between plan and
 *  apply (offsets shifted, or the link itself was rewritten). Caller treats
 *  `null` as a failed referrer rather than corrupting the file. */
function applyEditsBackToFront(
  content: string,
  edits: SpanEdit[]
): string | null {
  // Walk from the back so earlier offsets stay valid as we splice.
  let out = content;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.start < 0 || e.end > out.length || e.start > e.end) {
      return null;
    }
    if (out.slice(e.start, e.end) !== e.expected) {
      return null;
    }
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/** Bounded retry for the case where `applyEditsBackToFront` failed because
 *  an unrelated edit (Obsidian sync, text editor, concurrent rename_tag)
 *  shifted byte offsets without touching the links themselves. For each
 *  planned edit we look for its `expected` substring in the current
 *  content. If every expected slice still appears exactly once, we splice
 *  at the new positions and return the rewritten content. If any expected
 *  slice is missing, ambiguous (>1 match), or would cause overlapping
 *  splices, we return null and the caller surfaces the failure rather
 *  than picking the wrong occurrence. */
function retryEditsByContent(
  content: string,
  edits: SpanEdit[]
): string | null {
  type Match = { start: number; end: number; replacement: string };
  const matches: Match[] = [];
  for (const e of edits) {
    const first = content.indexOf(e.expected);
    if (first < 0) return null;
    const second = content.indexOf(e.expected, first + 1);
    if (second >= 0) return null;
    matches.push({
      start: first,
      end: first + e.expected.length,
      replacement: e.replacement,
    });
  }
  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i]!.start < matches[i - 1]!.end) return null;
  }
  let out = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    out = out.slice(0, m.start) + m.replacement + out.slice(m.end);
  }
  return out;
}

/** Tolerant `decodeURIComponent`: returns the input unchanged on malformed
 *  percent-escapes rather than throwing. Vault paths sometimes contain raw
 *  spaces or characters that aren't valid URI components. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function existingMarkdownAttachment(
  vaultPath: string,
  decodedPath: string,
  notePath: string
): Promise<{ target: string; relative: boolean } | null> {
  if (!path.posix.extname(decodedPath) || /\.md$/i.test(decodedPath)) return null;
  const targets = isExplicitRelativePath(decodedPath)
    ? [path.posix.join(referrerDir(notePath), decodedPath)]
    : [decodedPath, path.posix.join(referrerDir(notePath), decodedPath)];
  for (const target of targets) {
    try {
      const fullPath = await resolveVaultPathSafe(vaultPath, target, "read");
      if ((await fs.stat(fullPath)).isFile()) {
        return { target: path.posix.normalize(target), relative: target !== decodedPath };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveMarkdownLinkPath(
  decodedPath: string,
  notePath: string,
  allNotes: string[],
  aliasMap: Map<string, string>
): string | null {
  if (isExplicitRelativePath(decodedPath)) {
    const resolved = path.posix.normalize(
      path.posix.join(referrerDir(notePath), decodedPath)
    );
    if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
      return null;
    }
    const target = resolved.replace(/\.md$/i, "").toLowerCase();
    return allNotes.find((note) => note.replace(/\.md$/i, "").toLowerCase() === target) ?? null;
  }

  return resolveWikilink(decodedPath, notePath, allNotes, { aliasMap });
}

function formatMarkdownLinkTarget(
  newPath: string,
  originalBare: string,
  notePath: string,
  allNotes: string[]
): string {
  if (!isExplicitRelativePath(originalBare)) {
    return formatWikilinkTarget(newPath, originalBare, allNotes);
  }

  return relativeMarkdownTarget(newPath.replace(/\.md$/i, ""), notePath, originalBare);
}

function relativeMarkdownTarget(
  target: string,
  notePath: string,
  original: string
): string {
  const fromDir = referrerDir(notePath) || ".";
  let relative = path.posix.relative(fromDir, target);
  if (!relative) relative = path.posix.basename(target);
  if (original.startsWith("./") && !relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

function isExplicitRelativePath(p: string): boolean {
  return p.startsWith("./") || p.startsWith("../");
}

function referrerDir(notePath: string): string {
  const dir = path.posix.dirname(notePath.replace(/\\/g, "/"));
  return dir === "." ? "" : dir;
}

/** Encode a vault-relative path for use inside a markdown link URL. Keeps
 *  forward slashes literal (they're path separators) while escaping spaces
 *  and other characters that would break the `(...)` parser. */
function encodeUrlPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
