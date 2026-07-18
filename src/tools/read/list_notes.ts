import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { defineTool, richText } from "../../lib/tool-seam.js";
import { displayReadValue } from "./shared.js";

export function registerListNotesTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "list_notes",
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
          .describe(
            "Folder relative to vault root to restrict the listing (omit to list the entire vault)"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(50)
          .describe(
            "Maximum number of note paths to return (1-10000, default: 50). The full total count is still reported separately."
          ),
      },
    },
    async ({ folder, limit }) => {
      const notes = await listNotes(vaultPath, folder);
      const limited = notes.slice(0, limit);
      const totalCount = notes.length;

      return richText("list_notes paths", (b) => {
        b.trusted(
          `Found ${totalCount} note(s)${folder ? ` in "${displayReadValue(folder)}"` : ""}${totalCount > limit ? ` (showing first ${limit})` : ""}:`
        );
        b.trusted("");
        if (limited.length > 0) {
          b.untrusted(
            "list_notes paths",
            limited.map(displayReadValue).join("\n")
          );
        }
      });
    }
  );
}
