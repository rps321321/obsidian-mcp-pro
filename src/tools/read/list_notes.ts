import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { untrustedVaultContentMeta } from "../../lib/tool-output.js";
import { displayReadValue, errorResult, untrustedReadBlock } from "./shared.js";

export function registerListNotesTool(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_notes",
    {
      title: "List Notes",
      description:
        "Enumerate every markdown note in the vault (or a single folder), returning a sorted list of relative paths along with the total count. Truncates output to `limit` entries but still reports the total. Use to browse vault structure, build a file picker, or enumerate targets for batch processing.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        folder: z
          .string()
          .max(500)
          .optional()
          .describe("Folder relative to vault root to restrict the listing (omit to list the entire vault)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(50)
          .describe("Maximum number of note paths to return (1-10000, default: 50). The full total count is still reported separately."),
      },
    },
    async ({ folder, limit }) => {
      try {
        const notes = await listNotes(vaultPath, folder);
        const limited = notes.slice(0, limit);
        const totalCount = notes.length;

        const lines: string[] = [
          `Found ${totalCount} note(s)${folder ? ` in "${displayReadValue(folder)}"` : ""}${totalCount > limit ? ` (showing first ${limit})` : ""}:`,
          "",
        ];
        if (limited.length > 0) {
          lines.push(untrustedReadBlock("list_notes paths", limited.map(displayReadValue).join("\n")));
        }

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            ...(limited.length > 0 ? { _meta: untrustedVaultContentMeta("list_notes paths") } : {}),
          }],
        };
      } catch (err) {
        log.error("list_notes failed", { tool: "list_notes", err: err as Error });
        return errorResult(`Error listing notes: ${sanitizeError(err)}`);
      }
    },
  );
}
