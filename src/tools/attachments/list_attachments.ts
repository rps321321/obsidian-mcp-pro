import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAttachments } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import {
  textResult,
  textResultWithUntrustedMeta,
  errorResult,
  displayAttachmentValue,
  untrustedAttachmentBlock,
} from "./shared.js";

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

export function registerListAttachments(server: McpServer, vaultPath: string): void {
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
}
