import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import {
  listAttachments,
  listNotes,
  getAttachmentStats,
  getNoteStats,
  getVaultRootRealPath,
  openVaultFileForRead,
} from "../lib/vault.js";
import { readAllCached } from "../lib/index-cache.js";
import { makeProgressReporter } from "../lib/progress.js";
import { mapConcurrent } from "../lib/concurrency.js";
import {
  extractWikilinkSpans,
  extractMarkdownLinkSpans,
} from "../lib/markdown.js";
import {
  detectMimeType,
  categorizeMimeType,
  getBlockedExtension,
  verifyImageMagicBytes,
} from "../lib/mime.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../lib/tool-output.js";
import { log } from "../lib/logger.js";

/** Cap on attachment size returned by `get_attachment` — base64 inflates by
 *  ~33% on the wire and large attachments blow MCP host token budgets. The
 *  default mirrors Anthropic's image-input limit; users can opt in to larger
 *  with `maxBytes`. */
const DEFAULT_GET_ATTACHMENT_LIMIT = 5 * 1024 * 1024; // 5 MB
const ABSOLUTE_GET_ATTACHMENT_LIMIT = 50 * 1024 * 1024; // 50 MB hard cap
const ATTACHMENT_INVENTORY_CACHE_LIMIT = 8;

interface AttachmentInventoryCacheEntry {
  attachmentsFingerprint: string;
  noteFingerprint: string;
  referenced: Set<string>;
}

const attachmentInventoryCache = new Map<string, AttachmentInventoryCacheEntry>();

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function textResultWithUntrustedMeta(text: string, label: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Escape control characters in a value before embedding it in a display string. */
const displayAttachmentValue = escapeControlChars;

function untrustedAttachmentBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

function vaultResourceUri(relPath: string): string {
  return `vault://${relPath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
}

const ACTIVE_TEXT_MIME_TYPES = new Set([
  "text/html",
  "application/xml",
  "text/xml",
  "text/css",
]);

function safeResourceMimeType(mime: string): string {
  return ACTIVE_TEXT_MIME_TYPES.has(mime.toLowerCase()) ? "text/plain" : mime;
}

function hiddenAttachmentSegment(relPath: string): string | null {
  const segments = relPath.replace(/\\/g, "/").split("/");
  return segments.find((segment) =>
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    segment.startsWith(".")
  ) ?? null;
}

async function assertNoSymlinkAttachmentPath(
  vaultPath: string,
  fullPath: string,
  relPath: string,
): Promise<void> {
  const vaultRoot = path.resolve(vaultPath);
  const resolvedFullPath = path.resolve(fullPath);
  const relativeFromVault = path.relative(vaultRoot, resolvedFullPath);
  if (relativeFromVault.startsWith("..") || path.isAbsolute(relativeFromVault)) {
    throw new Error("Path traversal via symlink detected");
  }

  let current = vaultRoot;
  for (const segment of relativeFromVault.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to fetch symlink attachment: ${displayAttachmentValue(relPath)}`);
    }
  }
}

/** Group attachments by their lower-cased extension for the summary line. */
function summarizeByExtension(paths: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of paths) {
    const dot = p.lastIndexOf(".");
    const ext = dot >= 0 ? p.slice(dot).toLowerCase() : "(no ext)";
    out.set(ext, (out.get(ext) ?? 0) + 1);
  }
  return out;
}

function attachmentListFingerprint(attachments: readonly string[]): string {
  return attachments.join("\0");
}

function noteMtimeFingerprint(
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
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
  notes: readonly string[],
): Promise<string | undefined> {
  const realVaultRoot = await getVaultRootRealPath(vaultPath);
  const parts = await mapConcurrent(
    notes,
    16,
    async (notePath): Promise<string | undefined> => {
      try {
        const stats = await getNoteStats(vaultPath, notePath, { realVaultRoot });
        return `${notePath}\0${stats.modified?.getTime() ?? 0}`;
      } catch {
        return undefined;
      }
    },
  );
  if (parts.some((part) => part === undefined)) return undefined;
  return parts.join("\0");
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
  basenameIndex: ReadonlyMap<string, string[]>,
): { resolved: Set<string>; unresolved: string[] } {
  const resolved = new Set<string>();
  const unresolved: string[] = [];

  const consider = (rawTarget: string): void => {
    const t = rawTarget.split("#")[0]!.split("^")[0]!.trim();
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

async function getCachedAttachmentInventory(
  vaultPath: string,
  attachments: readonly string[],
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
  reportProgress: (progress: number, total: number, message?: string) => Promise<void>,
): Promise<AttachmentInventoryCacheEntry> {
  const attachmentsFingerprint = attachmentListFingerprint(attachments);
  const noteFingerprint = noteMtimeFingerprint(notes, contents, mtimes);
  const cacheKey = path.resolve(vaultPath);

  const lowerPathIndex = new Map<string, string>();
  const basenameIndex = new Map<string, string[]>();
  for (const p of attachments) {
    if (!lowerPathIndex.has(p.toLowerCase())) lowerPathIndex.set(p.toLowerCase(), p);
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
      const { resolved } = collectReferencedAttachments(content, lowerPathIndex, basenameIndex);
      for (const r of resolved) referenced.add(r);
    }
    scanned++;
    await reportProgress(scanned, notes.length, `Scanned ${scanned}/${notes.length} notes`);
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
  reportProgress: (progress: number, total: number, message?: string) => Promise<void>,
): Promise<AttachmentInventoryCacheEntry | undefined> {
  const cacheKey = path.resolve(vaultPath);
  const cached = attachmentInventoryCache.get(cacheKey);
  if (!cached || cached.attachmentsFingerprint !== attachmentListFingerprint(attachments)) {
    return undefined;
  }
  const currentNoteFingerprint = await noteStatsFingerprint(vaultPath, notes);
  if (currentNoteFingerprint === undefined || currentNoteFingerprint !== cached.noteFingerprint) {
    return undefined;
  }
  attachmentInventoryCache.delete(cacheKey);
  attachmentInventoryCache.set(cacheKey, cached);
  let scanned = 0;
  for (const _notePath of notes) {
    scanned++;
    await reportProgress(scanned, notes.length, `Scanned ${scanned}/${notes.length} notes`);
  }
  return cached;
}

export function registerAttachmentTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_attachments",
    {
      title: "List Attachments",
      description:
        "Enumerate every non-markdown file in the vault — images, PDFs, audio/video clips, anything pasted in beyond notes/canvases/Bases. Returns a sorted list of relative paths plus a per-extension count summary. Use to audit assets, find duplicates by name, or pick targets for find_unused_attachments.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        extension: z
          .string()
          .max(500)
          .optional()
          .describe("Restrict to one extension (e.g., 'png' or '.png'). Omit for every attachment."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(200)
          .describe("Maximum number of attachment paths to return (1-10000, default: 200). Total counts are still reported."),
      },
    },
    async ({ extension, limit }) => {
      try {
        const all = await listAttachments(vaultPath);
        const filtered = extension
          ? all.filter((p) => {
              const ext = (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase();
              return p.toLowerCase().endsWith(ext);
            })
          : all;
        if (filtered.length === 0) {
          return textResult(
            extension
              ? `No attachments with extension "${displayAttachmentValue(extension)}".`
              : "No attachments in this vault.",
          );
        }
        const truncated = filtered.slice(0, limit);
        const lines: string[] = [
          `${filtered.length} attachment(s)${extension ? ` (.${displayAttachmentValue(extension.replace(/^\./, ""))})` : ""}${filtered.length > limit ? ` (showing first ${limit})` : ""}:`,
          "",
        ];
        const summary = summarizeByExtension(filtered);
        let trustLabel = "list_attachments paths";
        if (summary.size > 1) {
          lines.push("By extension:");
          const entries = Array.from(summary.entries()).sort((a, b) => b[1] - a[1]);
          lines.push(untrustedAttachmentBlock(
            "list_attachments extensions",
            entries.map(([ext, n]) => `${displayAttachmentValue(ext)}  ${n}`).join("\n"),
            "  ",
          ));
          lines.push("");
          trustLabel = "list_attachments extensions and paths";
        }
        lines.push(untrustedAttachmentBlock(
          "list_attachments paths",
          truncated.map((p) => `- ${displayAttachmentValue(p)}`).join("\n"),
        ));
        return textResultWithUntrustedMeta(lines.join("\n"), trustLabel);
      } catch (err) {
        log.error("list_attachments failed", { tool: "list_attachments", err: err as Error });
        return errorResult(`Error listing attachments: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "find_unused_attachments",
    {
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
          .describe("Maximum number of unused-attachment paths to return (1-10000, default: 200). Total counts are still reported."),
        includeBytes: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, also stat each unused attachment and report total reclaimable bytes."),
      },
    },
    async ({ limit, includeBytes }, extra) => {
      try {
        const reportProgress = makeProgressReporter(extra);
        const attachments = await listAttachments(vaultPath);
        if (attachments.length === 0) {
          return textResult("No attachments in this vault — nothing to check.");
        }
        const notes = await listNotes(vaultPath);
        await reportProgress(0, notes.length, "Reading notes…");
        let inventory = await getReusableAttachmentInventory(vaultPath, attachments, notes, reportProgress);
        if (!inventory) {
          const { contents, mtimes } = await readAllCached(vaultPath, notes, (note, err) => {
            log.warn("find_unused_attachments: note read failed", { note, err });
          });

          inventory = await getCachedAttachmentInventory(
            vaultPath,
            attachments,
            notes,
            contents,
            mtimes,
            reportProgress,
          );
        }

        const unused = attachments.filter((p) => !inventory.referenced.has(p));
        if (unused.length === 0) {
          return textResult(
            `All ${attachments.length} attachment(s) are referenced — nothing to clean up.`,
          );
        }

        const truncated = unused.slice(0, limit);
        const lines: string[] = [
          `Found ${unused.length} unused attachment(s) of ${attachments.length} total${unused.length > limit ? ` (showing first ${limit})` : ""}:`,
          "",
        ];

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
          lines.push(`Total reclaimable: ${totalBytes.toLocaleString()} bytes (across all ${unused.length} unused attachment(s))`);
          lines.push("");
          const rowLines: string[] = [];
          for (const p of truncated) {
            const sz = sizes.get(p);
            const displayedPath = displayAttachmentValue(p);
            rowLines.push(sz !== undefined ? `- ${displayedPath}  (${sz.toLocaleString()} bytes)` : `- ${displayedPath}`);
          }
          lines.push(untrustedAttachmentBlock("find_unused_attachments paths", rowLines.join("\n")));
        } else {
          lines.push(untrustedAttachmentBlock(
            "find_unused_attachments paths",
            truncated.map((p) => `- ${displayAttachmentValue(p)}`).join("\n"),
          ));
        }

        return textResultWithUntrustedMeta(lines.join("\n"), "find_unused_attachments paths");
      } catch (err) {
        log.error("find_unused_attachments failed", {
          tool: "find_unused_attachments",
          err: err as Error,
        });
        return errorResult(`Error finding unused attachments: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get Attachment",
      description:
        "Read an attachment file and return its bytes to the client. Images come back as `image` content blocks (rendered inline by Claude / Cursor), audio as `audio` blocks, everything else as a base64 `resource` block with a vault:// URI. Caps at 5 MB by default to keep token usage sane; raise via `maxBytes` up to 50 MB. The attachment must be inside the vault — markdown notes (.md), canvases (.canvas), and Bases (.base) are deliberately rejected so callers don't accidentally pull text-format files through this binary path; use get_note / read_canvas / read_base instead.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe("Vault-relative path to the attachment, e.g. 'assets/diagram.png'."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(ABSOLUTE_GET_ATTACHMENT_LIMIT)
          .optional()
          .describe(`Maximum file size to fetch in bytes (default: ${DEFAULT_GET_ATTACHMENT_LIMIT.toLocaleString()}, hard cap: ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`),
      },
    },
    async ({ path: relPath, maxBytes }) => {
      try {
        const hiddenName = hiddenAttachmentSegment(relPath);
        if (hiddenName) {
          return errorResult(
            `Refusing to fetch hidden attachment "${displayAttachmentValue(relPath)}" via get_attachment.`,
          );
        }

        // Reject text-format files so the wrong tool isn't used on them.
        const lowerPath = relPath.toLowerCase();
        if (lowerPath.endsWith(".md") || lowerPath.endsWith(".canvas") || lowerPath.endsWith(".base")) {
          return errorResult(
            `Refusing to fetch "${displayAttachmentValue(relPath)}" via get_attachment - use get_note / read_canvas / read_base instead.`,
          );
        }

        // SEC-7: Block dangerous executable extensions.
        const blockedExt = getBlockedExtension(relPath);
        if (blockedExt) {
          return errorResult(
            `Blocked: "${displayAttachmentValue(relPath)}" has a dangerous extension (${displayAttachmentValue(blockedExt)}). ` +
            `Executable file types are not served as attachments.`,
          );
        }

        const limit = maxBytes ?? DEFAULT_GET_ATTACHMENT_LIMIT;
        let opened: Awaited<ReturnType<typeof openVaultFileForRead>>;
        try {
          opened = await openVaultFileForRead(vaultPath, relPath);
        } catch (err) {
          if ((err as Error).message === `Not a regular file: ${relPath}`) {
            return errorResult(
              `Attachment "${displayAttachmentValue(relPath)}" is not a regular file.`,
            );
          }
          throw err;
        }
        const handle = opened.handle;
        let bytes: Buffer;
        try {
          await assertNoSymlinkAttachmentPath(vaultPath, opened.fullPath, relPath);
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return errorResult(
              `Attachment "${displayAttachmentValue(relPath)}" is not a regular file.`,
            );
          }
          if (stat.size > limit) {
            return errorResult(
              `Attachment "${displayAttachmentValue(relPath)}" is ${stat.size.toLocaleString()} bytes - over the ${limit.toLocaleString()}-byte limit. Pass maxBytes to override (hard cap ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`,
            );
          }
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (bytes.byteLength > limit) {
          return errorResult(
            `Attachment "${displayAttachmentValue(relPath)}" is ${bytes.byteLength.toLocaleString()} bytes - over the ${limit.toLocaleString()}-byte limit. Pass maxBytes to override (hard cap ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`,
          );
        }
        const attachmentSize = bytes.byteLength;
        const mime = detectMimeType(relPath);
        const category = categorizeMimeType(mime);
        const basename = path.basename(relPath);
        const displayedBasename = displayAttachmentValue(basename);

        // SEC-8: SVG files can contain embedded <script> tags and event
        // handlers, making them an XSS vector. Return SVG content as
        // plain text instead of as an image embed.
        if (mime === "image/svg+xml") {
          const svgText = bytes.toString("utf-8");
          const trustLabel = "get_attachment text";
          return {
            content: [
              {
                type: "text" as const,
                text: `Attached: ${displayedBasename} (SVG returned as text/plain for security - SVGs may contain embedded scripts)\n` +
                      `Size: ${attachmentSize.toLocaleString()} bytes`,
              },
              {
                type: "resource" as const,
                resource: {
                  uri: vaultResourceUri(relPath),
                  mimeType: "text/plain",
                  text: formatUntrustedVaultContent(trustLabel, svgText),
                  _meta: untrustedVaultContentMeta(trustLabel),
                },
                _meta: untrustedVaultContentMeta(trustLabel),
              },
            ],
          };
        }

        // SEC-9: Best-effort magic-bytes verification for image types.
        // A mismatch means the file extension doesn't match the actual
        // content - warn the caller but still serve the file.
        let magicWarning = "";
        if (category === "image") {
          const magicCheck = verifyImageMagicBytes(mime, bytes);
          if (magicCheck === false) {
            magicWarning =
              ` [WARNING: file header does not match expected ${mime} signature - ` +
              `the extension may be misleading]`;
          }
        }

        const data = bytes.toString("base64");

        // Image / audio content blocks render natively in compatible
        // clients; everything else round-trips as a `resource` block so the
        // client can save it, hand it off to a tool, or display a download
        // affordance.
        if (category === "image") {
          return {
            content: [
              { type: "text" as const, text: `Attached: ${displayedBasename} (${mime}, ${attachmentSize.toLocaleString()} bytes)${magicWarning}` },
              { type: "image" as const, data, mimeType: mime },
            ],
          };
        }
        if (category === "audio") {
          return {
            content: [
              { type: "text" as const, text: `Attached: ${displayedBasename} (${mime}, ${attachmentSize.toLocaleString()} bytes)` },
              { type: "audio" as const, data, mimeType: mime },
            ],
          };
        }
        const resourceMime = safeResourceMimeType(mime);
        const mimeLabel = resourceMime === mime ? mime : `${mime} returned as ${resourceMime}`;
        return {
          content: [
            { type: "text" as const, text: `Attached: ${displayedBasename} (${mimeLabel}, ${attachmentSize.toLocaleString()} bytes)` },
            {
              type: "resource" as const,
              resource: {
                // vault:// URI lets clients distinguish vault files from
                // arbitrary URLs in their UI without leaking the host path.
                uri: vaultResourceUri(relPath),
                mimeType: resourceMime,
                blob: data,
              },
            },
          ],
        };
      } catch (err) {
        log.error("get_attachment failed", { tool: "get_attachment", err: err as Error });
        return errorResult(`Error reading attachment: ${sanitizeError(err)}`);
      }
    },
  );
}
