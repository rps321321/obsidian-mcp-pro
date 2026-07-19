import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAttachments } from "../../lib/vault.js";
import { defineTool, text, richText } from "../../lib/tool-seam.js";
import { displayAttachmentValue } from "./shared.js";

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

export function registerListAttachments(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "list_attachments",
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
          .describe(
            "Restrict to one extension (e.g., 'png' or '.png'). Omit for every attachment."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(200)
          .describe(
            "Maximum number of attachment paths to return (1-10000, default: 200). Total counts are still reported."
          ),
      },
    },
    async ({ extension, limit }) => {
      const all = await listAttachments(vaultPath);
      const filtered = extension
        ? all.filter((p) => {
            const ext = (
              extension.startsWith(".") ? extension : `.${extension}`
            ).toLowerCase();
            return p.toLowerCase().endsWith(ext);
          })
        : all;
      if (filtered.length === 0) {
        return text(
          extension
            ? `No attachments with extension "${displayAttachmentValue(extension)}".`
            : "No attachments in this vault."
        );
      }
      const truncated = filtered.slice(0, limit);
      const summary = summarizeByExtension(filtered);
      const hasExtensionBreakdown = summary.size > 1;
      const trustLabel = hasExtensionBreakdown
        ? "list_attachments extensions and paths"
        : "list_attachments paths";

      return richText(trustLabel, (b) => {
        b.trusted(
          `${filtered.length} attachment(s)${extension ? ` (.${displayAttachmentValue(extension.replace(/^\./, ""))})` : ""}${filtered.length > limit ? ` (showing first ${limit})` : ""}:`
        );
        b.trusted("");
        if (hasExtensionBreakdown) {
          b.trusted("By extension:");
          const entries = Array.from(summary.entries()).sort(
            (a, b) => b[1] - a[1]
          );
          b.untrusted(
            "list_attachments extensions",
            entries
              .map(([ext, n]) => `${displayAttachmentValue(ext)}  ${n}`)
              .join("\n"),
            "  "
          );
          b.trusted("");
        }
        b.untrusted(
          "list_attachments paths",
          truncated.map((p) => `- ${displayAttachmentValue(p)}`).join("\n")
        );
      });
    }
  );
}
