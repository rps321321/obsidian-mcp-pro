import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import {
  listAttachments,
  listNotes,
  getAttachmentStats,
  getNoteStats,
  getVaultRootRealPath,
} from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { makeProgressReporter } from "../../lib/progress.js";
import { mapConcurrent } from "../../lib/concurrency.js";
import {
  extractWikilinkSpans,
  extractMarkdownLinkSpans,
} from "../../lib/markdown.js";
import { log } from "../../lib/logger.js";
import { defineTool, text, richText } from "../../lib/tool-seam.js";
import { displayAttachmentValue } from "./shared.js";

const ATTACHMENT_INVENTORY_CACHE_LIMIT = 8;

interface AttachmentInventoryCacheEntry {
  attachmentsFingerprint: string;
  noteFingerprint: string;
  referenced: Set<string>;
}

const attachmentInventoryCache = new Map<
  string,
  AttachmentInventoryCacheEntry
>();

function isExternalMarkdownTarget(target: string): boolean {
  if (target.startsWith("//")) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  return /^(?:data|file|http|https|mailto|obsidian|tel):/i.test(target);
}

function normalizeLocalMarkdownTarget(target: string): string {
  const slashed = target.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashed);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return slashed;
  }
  return normalized.replace(/\/+$/g, "");
}

/**
 * Resolve the set of attachment paths referenced by a single note. Considers:
 *   - `![[file.png]]` and `![[file.png|alt]]` wikilink embeds
 *   - `[text](file.png)` and `![text](file.png)` markdown links / embeds
 *
 * Resolution mirrors Obsidian's: an exact relative-path match wins; otherwise
 * a basename match across all attachments. Tracks unresolved references so
 * callers can surface them as broken-attachment links.
 */
function collectReferencedAttachments(
  noteContent: string,
  lowerPathIndex: ReadonlyMap<string, string>,
  basenameIndex: ReadonlyMap<string, string[]>
): { resolved: Set<string>; unresolved: string[] } {
  const resolved = new Set<string>();
  const unresolved: string[] = [];

  const consider = (rawTarget: string): void => {
    const trimmedTarget = rawTarget.trim();
    if (isExternalMarkdownTarget(trimmedTarget)) return;

    const t = normalizeLocalMarkdownTarget(
      trimmedTarget.split("#")[0]!.split("^")[0]!.trim()
    );
    if (!t) return;

    // 1) Exact relative-path match (case-insensitive on case-insensitive FS,
    //    but we lowercase consistently to keep cross-platform behavior stable).
    const lower = t.toLowerCase();
    const exact = lowerPathIndex.get(lower);
    if (exact) {
      resolved.add(exact);
      return;
    }

    // 2) Basename match. Obsidian also allows missing extensions on
    //    attachment links, but only for image/PDF formats — we stay strict
    //    and require the extension to keep this code small.
    const base = path.basename(t).toLowerCase();
    const candidates = basenameIndex.get(base);
    if (candidates && candidates.length > 0) {
      for (const c of candidates) resolved.add(c);
      return;
    }

    unresolved.push(t);
  };

  for (const span of extractWikilinkSpans(noteContent)) {
    if (!span.isEmbed) continue;
    consider(span.target);
  }
  for (const span of extractMarkdownLinkSpans(noteContent)) {
    // Markdown embed: `![text](url.png)`. The `isEmbed` flag captures `!`.
    // Plain `[text](url)` to a file is also a reference, even without `!`.
    consider(span.urlPath);
  }
  return { resolved, unresolved };
}

function attachmentListFingerprint(attachments: readonly string[]): string {
  return attachments.join("\0");
}

function noteMtimeFingerprint(
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>
): string {
  return notes
    .map((notePath) => {
      const mtime = mtimes.get(notePath);
      return `${notePath}\0${contents.has(notePath) && mtime !== undefined ? mtime : "missing"}`;
    })
    .join("\0");
}

async function noteStatsFingerprint(
  vaultPath: string,
  notes: readonly string[]
): Promise<string | undefined> {
  const realVaultRoot = await getVaultRootRealPath(vaultPath);
  const parts = await mapConcurrent(
    notes,
    16,
    async (notePath): Promise<string | undefined> => {
      try {
        const stats = await getNoteStats(vaultPath, notePath, {
          realVaultRoot,
        });
        return `${notePath}\0${stats.modified?.getTime() ?? 0}`;
      } catch {
        return undefined;
      }
    }
  );
  if (parts.some((part) => part === undefined)) return undefined;
  return parts.join("\0");
}

async function getCachedAttachmentInventory(
  vaultPath: string,
  attachments: readonly string[],
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
  reportProgress: (
    progress: number,
    total: number,
    message?: string
  ) => Promise<void>
): Promise<AttachmentInventoryCacheEntry> {
  const attachmentsFingerprint = attachmentListFingerprint(attachments);
  const noteFingerprint = noteMtimeFingerprint(notes, contents, mtimes);
  const cacheKey = path.resolve(vaultPath);

  const lowerPathIndex = new Map<string, string>();
  const basenameIndex = new Map<string, string[]>();
  for (const p of attachments) {
    if (!lowerPathIndex.has(p.toLowerCase()))
      lowerPathIndex.set(p.toLowerCase(), p);
    const base = path.basename(p).toLowerCase();
    const list = basenameIndex.get(base);
    if (list) list.push(p);
    else basenameIndex.set(base, [p]);
  }

  const referenced = new Set<string>();
  let scanned = 0;
  for (const notePath of notes) {
    const content = contents.get(notePath);
    if (content !== undefined) {
      const { resolved } = collectReferencedAttachments(
        content,
        lowerPathIndex,
        basenameIndex
      );
      for (const r of resolved) referenced.add(r);
    }
    scanned++;
    await reportProgress(
      scanned,
      notes.length,
      `Scanned ${scanned}/${notes.length} notes`
    );
  }

  const fresh = { attachmentsFingerprint, noteFingerprint, referenced };
  attachmentInventoryCache.set(cacheKey, fresh);
  while (attachmentInventoryCache.size > ATTACHMENT_INVENTORY_CACHE_LIMIT) {
    const oldestKey = attachmentInventoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    attachmentInventoryCache.delete(oldestKey);
  }
  return fresh;
}

async function getReusableAttachmentInventory(
  vaultPath: string,
  attachments: readonly string[],
  notes: readonly string[],
  reportProgress: (
    progress: number,
    total: number,
    message?: string
  ) => Promise<void>
): Promise<AttachmentInventoryCacheEntry | undefined> {
  const cacheKey = path.resolve(vaultPath);
  const cached = attachmentInventoryCache.get(cacheKey);
  if (
    !cached ||
    cached.attachmentsFingerprint !== attachmentListFingerprint(attachments)
  ) {
    return undefined;
  }
  const currentNoteFingerprint = await noteStatsFingerprint(vaultPath, notes);
  if (
    currentNoteFingerprint === undefined ||
    currentNoteFingerprint !== cached.noteFingerprint
  ) {
    return undefined;
  }
  attachmentInventoryCache.delete(cacheKey);
  attachmentInventoryCache.set(cacheKey, cached);
  let scanned = 0;
  for (const _notePath of notes) {
    scanned++;
    await reportProgress(
      scanned,
      notes.length,
      `Scanned ${scanned}/${notes.length} notes`
    );
  }
  return cached;
}

export function registerFindUnusedAttachments(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "find_unused_attachments",
      title: "Find Unused Attachments",
      description:
        "Locate attachments that no note references — neither via `![[file]]` embeds nor `[text](file)` markdown links. Useful for vault hygiene before archiving or before running a sync. Pair the output with `delete` operations from your shell, since this tool deliberately doesn't unlink files.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(200)
          .describe(
            "Maximum number of unused-attachment paths to return (1-10000, default: 200). Total counts are still reported."
          ),
        includeBytes: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, also stat each unused attachment and report total reclaimable bytes."
          ),
      },
    },
    async ({ limit, includeBytes }, { extra }) => {
      const reportProgress = makeProgressReporter(extra);
      const attachments = await listAttachments(vaultPath);
      if (attachments.length === 0) {
        return text("No attachments in this vault — nothing to check.");
      }
      const notes = await listNotes(vaultPath);
      await reportProgress(0, notes.length, "Reading notes…");
      let inventory = await getReusableAttachmentInventory(
        vaultPath,
        attachments,
        notes,
        reportProgress
      );
      if (!inventory) {
        const { contents, mtimes } = await readAllCached(
          vaultPath,
          notes,
          (note, err) => {
            log.warn("find_unused_attachments: note read failed", {
              note,
              err,
            });
          }
        );

        inventory = await getCachedAttachmentInventory(
          vaultPath,
          attachments,
          notes,
          contents,
          mtimes,
          reportProgress
        );
      }

      const unused = attachments.filter((p) => !inventory.referenced.has(p));
      if (unused.length === 0) {
        return text(
          `All ${attachments.length} attachment(s) are referenced — nothing to clean up.`
        );
      }

      const truncated = unused.slice(0, limit);
      const header = `Found ${unused.length} unused attachment(s) of ${attachments.length} total${unused.length > limit ? ` (showing first ${limit})` : ""}:`;

      let totalLine: string | null = null;
      let rowLines: string[];
      if (includeBytes) {
        // Stat ALL unused attachments so "Total reclaimable" reflects the
        // full set the user would be deleting, not just the truncated view.
        // Otherwise a user acting on the number silently under-deletes.
        let totalBytes = 0;
        const sizes = new Map<string, number>();
        for (const p of unused) {
          try {
            const stat = await getAttachmentStats(vaultPath, p);
            sizes.set(p, stat.size);
            totalBytes += stat.size;
          } catch {
            // skip — file may have been removed mid-scan
          }
        }
        totalLine = `Total reclaimable: ${totalBytes.toLocaleString()} bytes (across all ${unused.length} unused attachment(s))`;
        rowLines = truncated.map((p) => {
          const sz = sizes.get(p);
          const displayedPath = displayAttachmentValue(p);
          return sz !== undefined
            ? `- ${displayedPath}  (${sz.toLocaleString()} bytes)`
            : `- ${displayedPath}`;
        });
      } else {
        rowLines = truncated.map((p) => `- ${displayAttachmentValue(p)}`);
      }

      return richText("find_unused_attachments paths", (b) => {
        b.trusted(header);
        b.trusted("");
        if (totalLine !== null) {
          b.trusted(totalLine);
          b.trusted("");
        }
        b.untrusted("find_unused_attachments paths", rowLines.join("\n"));
      });
    }
  );
}
