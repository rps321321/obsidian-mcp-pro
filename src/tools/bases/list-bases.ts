import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listBaseFiles } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { textResult, untrustedTextResult, errorResult, displayBaseValue, untrustedBaseBlock } from "./shared.js";

export function registerListBases(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_bases",
    {
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
      try {
        const bases = await listBaseFiles(vaultPath);
        if (bases.length === 0) return textResult("No .base files in this vault.");
        const lines = [`Found ${bases.length} Base file(s):`, ""];
        lines.push(untrustedBaseBlock("list_bases paths", bases.map(displayBaseValue).join("\n")));
        return untrustedTextResult("list_bases paths", lines.join("\n"));
      } catch (err) {
        log.error("list_bases failed", { tool: "list_bases", err: err as Error });
        return errorResult(`Error listing bases: ${sanitizeError(err)}`);
      }
    },
  );
}
