import fs from "fs/promises";
import path from "path";
import {
  listNotes,
  listCanvasFiles,
  readNote,
  readCanvasFile,
  resolveVaultPathSafe,
  withFileLock,
  atomicWriteFile,
} from "./vault.js";
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
  preMoveNotes: string[],
): Promise<RewritePlan> {
  // Build the post-move note set by substituting old → new. Used for picking
  // the output form (basename vs path) that matches Obsidian's behavior.
  const postMoveNotes = preMoveNotes.map((n) => (n === oldPath ? newPath : n));

  // Build an alias map from the pre-move state. Mirrors the logic in
  // tools/links.ts so resolution behavior is identical.
  const aliasMap = new Map<string, string>();
  await mapConcurrent(preMoveNotes, SCAN_CONCURRENCY, async (notePath) => {
    let content: string;
    try {
      content = await readNote(vaultPath, notePath);
    } catch {
      return undefined;
    }
    for (const alias of extractAliases(content)) {
      const key = alias.toLowerCase();
      if (key) aliasMap.set(key, notePath);
    }
    return undefined;
  });

  const notesPlan = new Map<string, SpanEdit[]>();

  // Markdown file pass.
  await mapConcurrent(preMoveNotes, SCAN_CONCURRENCY, async (notePath) => {
    let content: string;
    try {
      content = await readNote(vaultPath, notePath);
    } catch (err) {
      log.warn("link-rewriter: read failed during plan", {
        note: notePath,
        err: err as Error,
      });
      return undefined;
    }

    const edits: SpanEdit[] = [];

    // Wikilinks.
    for (const span of extractWikilinkSpans(content)) {
      if (!span.target) continue;
      const resolved = resolveWikilink(span.target, notePath, preMoveNotes, { aliasMap });
      if (resolved !== oldPath) continue;

      // Don't rewrite a self-reference inside the moved file itself — the
      // file's path is changing too, so the link's resolution travels with
      // the new file. Leaving it untouched is the simpler invariant.
      if (notePath === oldPath) continue;

      const newTarget = formatWikilinkTarget(newPath, span.target, postMoveNotes);
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
      if (notePath === oldPath) continue;
      const url = span.urlPath;
      // Skip absolute / external URLs — only intra-vault references rewrite.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith("/")) continue;
      const decoded = safeDecode(url);
      const resolved = resolveWikilink(decoded, notePath, preMoveNotes, { aliasMap });
      if (resolved !== oldPath) continue;

      // Preserve the user's choice of with/without `.md` extension and their
      // basename-vs-path style. `formatWikilinkTarget` handles the
      // basename-collision check so a post-move ambiguous basename falls back
      // to the full path automatically.
      const hadExt = /\.md$/i.test(decoded);
      const decodedBare = decoded.replace(/\.md$/i, "");
      const newBare = formatWikilinkTarget(newPath, decodedBare, postMoveNotes);
      const newUrl = encodeUrlPath(hadExt ? `${newBare}.md` : newBare);
      const replacement = `${span.isEmbed ? "!" : ""}[${span.text}](${newUrl}${span.fragment}${span.title})`;
      const expected = content.slice(span.start, span.end);
      if (replacement === expected) continue;
      edits.push({ start: span.start, end: span.end, expected, replacement });
    }

    if (edits.length > 0) {
      // Edits within a file may have been produced in interleaved order
      // (wikilinks then markdown links). Sort ascending so the apply step can
      // walk back-to-front cleanly.
      edits.sort((a, b) => a.start - b.start);
      notesPlan.set(notePath, edits);
    }
    return undefined;
  });

  // Canvas pass — `nodes[].file` is the structured equivalent of a wikilink,
  // and Obsidian stores the vault-relative path verbatim. Match by exact
  // (case-insensitive) path equality on the old path.
  const canvasPaths = await listCanvasFiles(vaultPath);
  const oldLower = oldPath.toLowerCase();
  const canvasesToRewrite: string[] = [];
  await mapConcurrent(canvasPaths, SCAN_CONCURRENCY, async (cp) => {
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
      if (typeof node.file === "string" && node.file.toLowerCase() === oldLower) {
        canvasesToRewrite.push(cp);
        return undefined;
      }
    }
    return undefined;
  });

  return {
    notes: notesPlan,
    canvases: canvasesToRewrite,
    oldPath,
    newPath,
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
  plan: RewritePlan,
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
        const fullPath = await resolveVaultPathSafe(vaultPath, notePath);
        let didWrite = false;
        await withFileLock(fullPath, async () => {
          // Re-read inside the lock so we apply edits to current content.
          // applyEditsBackToFront verifies each edit's `expected` slice
          // matches before splicing — a parallel `write_note` that landed
          // between plan and apply will fail the comparison and we report
          // the file rather than corrupting it.
          const current = await fs.readFile(fullPath, "utf-8");
          const next = applyEditsBackToFront(current, edits);
          if (next === null) {
            failed.push({
              path: notePath,
              error: "content changed during move; references not updated",
            });
            return;
          }
          if (next !== current) {
            await atomicWriteFile(fullPath, next);
            didWrite = true;
          }
        });
        if (didWrite) updated.push(notePath);
      } catch (err) {
        failed.push({ path: notePath, error: (err as Error).message });
      }
      return undefined;
    },
  );

  // Canvas pass.
  for (const cp of plan.canvases) {
    try {
      const fullPath = await resolveVaultPathSafe(vaultPath, cp);
      let didWrite = false;
      await withFileLock(fullPath, async () => {
        const raw = await fs.readFile(fullPath, "utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Invalid canvas file (malformed JSON): ${cp}`);
        }
        const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
        const nodes = Array.isArray(obj.nodes) ? (obj.nodes as Array<Record<string, unknown>>) : [];
        let mutated = false;
        const oldLower = plan.oldPath.toLowerCase();
        for (const node of nodes) {
          if (typeof node.file === "string" && node.file.toLowerCase() === oldLower) {
            node.file = plan.newPath;
            mutated = true;
          }
        }
        if (mutated) {
          await atomicWriteFile(fullPath, JSON.stringify({ ...obj, nodes }, null, 2));
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
  edits: SpanEdit[],
): string | null {
  // Walk from the back so earlier offsets stay valid as we splice.
  let out = content;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
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

/** Encode a vault-relative path for use inside a markdown link URL. Keeps
 *  forward slashes literal (they're path separators) while escaping spaces
 *  and other characters that would break the `(...)` parser. */
function encodeUrlPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
