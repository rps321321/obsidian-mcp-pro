import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, untrustedText } from "../../lib/tool-seam.js";
import { readSectionListCached } from "./shared.js";

export function registerListSectionsTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "list_sections",
      title: "List Sections",
      description:
        "List all headings in a note as a tree of paths (with depth). Useful for discovering valid `section` arguments before calling get_note, update_section, or insert_at_section.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
      },
    },
    async ({ path: notePath }) => {
      return untrustedText(
        "list_sections headings",
        await readSectionListCached(vaultPath, notePath)
      );
    }
  );
}
