import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import {
  listAttachments,
  listNotes,
  getAttachmentStats,
  resolveVaultPathSafe,
} from "../lib/vault.js";
import { readAllCached } from "../lib/index-cache.js";
import { makeProgressReporter } from "../lib/progress.js";
import {
  extractWikilinkSpans,
  extractMarkdownLinkSpans,
} from "../lib/markdown.js";
import { detectMimeType, categorizeMimeType } from "../lib/mime.js";
import { sanitizeError } from "../lib/errors.js";
import { log } from "../lib/logger.js";

/** Cap on attachment size returned by `get_attachment` — base64 inflates by
 *  ~33% on the wire and large attachments blow MCP host token budgets. The
 *  default mirrors Anthropic's image-input limit; users can opt in to larger
 *  with `maxBytes`. */
const DEFAULT_GET_ATTACHMENT_LIMIT = 5 * 1024 * 1024; // 5 MB
const ABSOLUTE_GET_ATTACHMENT_LIMIT = 50 * 1024 * 1024; // 50 MB hard cap

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
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
  attachmentSet: ReadonlySet<string>,
  basenameIndex: ReadonlyMap<string, string[]>,
): { resolved: Set<string>; unresolved: string[] } {
  const resolved = new Set<string>();
  const unresolved: string[] = [];

  const consider = (rawTarget: string): void => {
    const t = rawTarget.split("#")[0].split("^")[0].trim();
    if (!t) return;

    // 1) Exact relative-path match (case-insensitive on case-insensitive FS,
    //    but we lowercase consistently to keep cross-platform behavior stable).
    const lower = t.toLowerCase();
    for (const att of attachmentSet) {
      if (att.toLowerCase() === lower) {
        resolved.add(att);
        return;
      }
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
              ? `No attachments with extension "${extension}".`
              : "No attachments in this vault.",
          );
        }
        const truncated = filtered.slice(0, limit);
        const lines: string[] = [
          `${filtered.length} attachment(s)${extension ? ` (.${extension.replace(/^\./, "")})` : ""}${filtered.length > limit ? ` (showing first ${limit})` : ""}:`,
          "",
        ];
        const summary = summarizeByExtension(filtered);
        if (summary.size > 1) {
          lines.push("By extension:");
          const entries = Array.from(summary.entries()).sort((a, b) => b[1] - a[1]);
          for (const [ext, n] of entries) lines.push(`  ${ext}  ${n}`);
          lines.push("");
        }
        for (const p of truncated) lines.push(`- ${p}`);
        return textResult(lines.join("\n"));
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
        const attachmentSet = new Set(attachments);
        const basenameIndex = new Map<string, string[]>();
        for (const p of attachments) {
          const base = path.basename(p).toLowerCase();
          const list = basenameIndex.get(base);
          if (list) list.push(p);
          else basenameIndex.set(base, [p]);
        }

        const notes = await listNotes(vaultPath);
        await reportProgress(0, notes.length, "Reading notes…");
        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("find_unused_attachments: note read failed", { note, err });
        });

        const referenced = new Set<string>();
        let scanned = 0;
        for (const notePath of notes) {
          const content = contents.get(notePath);
          if (content !== undefined) {
            const { resolved } = collectReferencedAttachments(content, attachmentSet, basenameIndex);
            for (const r of resolved) referenced.add(r);
          }
          scanned++;
          await reportProgress(scanned, notes.length, `Scanned ${scanned}/${notes.length} notes`);
        }

        const unused = attachments.filter((p) => !referenced.has(p));
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
          let totalBytes = 0;
          const sizes = new Map<string, number>();
          for (const p of truncated) {
            try {
              const stat = await getAttachmentStats(vaultPath, p);
              sizes.set(p, stat.size);
              totalBytes += stat.size;
            } catch {
              // skip — file may have been removed mid-scan
            }
          }
          lines.push(`Total reclaimable: ${totalBytes.toLocaleString()} bytes`);
          lines.push("");
          for (const p of truncated) {
            const sz = sizes.get(p);
            lines.push(sz !== undefined ? `- ${p}  (${sz.toLocaleString()} bytes)` : `- ${p}`);
          }
        } else {
          for (const p of truncated) lines.push(`- ${p}`);
        }

        return textResult(lines.join("\n"));
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
        // Reject text-format files so the wrong tool isn't used on them.
        const lowerPath = relPath.toLowerCase();
        if (lowerPath.endsWith(".md") || lowerPath.endsWith(".canvas") || lowerPath.endsWith(".base")) {
          return errorResult(
            `Refusing to fetch "${relPath}" via get_attachment — use get_note / read_canvas / read_base instead.`,
          );
        }

        const fullPath = await resolveVaultPathSafe(vaultPath, relPath);
        const stat = await fs.stat(fullPath);
        const limit = maxBytes ?? DEFAULT_GET_ATTACHMENT_LIMIT;
        if (stat.size > limit) {
          return errorResult(
            `Attachment "${relPath}" is ${stat.size.toLocaleString()} bytes — over the ${limit.toLocaleString()}-byte limit. Pass maxBytes to override (hard cap ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`,
          );
        }

        const bytes = await fs.readFile(fullPath);
        const mime = detectMimeType(relPath);
        const category = categorizeMimeType(mime);
        const data = bytes.toString("base64");
        const basename = path.basename(relPath);

        // Image / audio content blocks render natively in compatible
        // clients; everything else round-trips as a `resource` block so the
        // client can save it, hand it off to a tool, or display a download
        // affordance.
        if (category === "image") {
          return {
            content: [
              { type: "text" as const, text: `Attached: ${basename} (${mime}, ${stat.size.toLocaleString()} bytes)` },
              { type: "image" as const, data, mimeType: mime },
            ],
          };
        }
        if (category === "audio") {
          return {
            content: [
              { type: "text" as const, text: `Attached: ${basename} (${mime}, ${stat.size.toLocaleString()} bytes)` },
              { type: "audio" as const, data, mimeType: mime },
            ],
          };
        }
        return {
          content: [
            { type: "text" as const, text: `Attached: ${basename} (${mime}, ${stat.size.toLocaleString()} bytes)` },
            {
              type: "resource" as const,
              resource: {
                // vault:// URI lets clients distinguish vault files from
                // arbitrary URLs in their UI without leaking the host path.
                uri: `vault://${relPath}`,
                mimeType: mime,
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
