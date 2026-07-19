import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listBaseFiles } from "../../lib/vault.js";
import { defineTool, text, richText } from "../../lib/tool-seam.js";
import { displayBaseValue } from "./shared.js";

export function registerListBases(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "list_bases",
      title: "List Bases",
      description:
        "Enumerate every Obsidian Bases (`.base`) file in the vault. Bases are YAML-defined database views over notes (filters, properties, table/calendar/kanban views). Returns a sorted list of relative paths plus the total count. Pair with read_base or query_base.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      const bases = await listBaseFiles(vaultPath);
      if (bases.length === 0) return text("No .base files in this vault.");
      return richText("list_bases paths", (b) => {
        b.trusted(`Found ${bases.length} Base file(s):`);
        b.trusted("");
        b.untrusted("list_bases paths", bases.map(displayBaseValue).join("\n"));
      });
    },
  );
}
