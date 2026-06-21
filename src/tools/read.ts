import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchNotesTool } from "./read/search_notes.js";
import { registerGetNoteTool } from "./read/get_note.js";
import { registerListNotesTool } from "./read/list_notes.js";
import { registerGetDailyNoteTool } from "./read/get_daily_note.js";
import { registerSearchByFrontmatterTool } from "./read/search_by_frontmatter.js";
import { registerGetRecentNotesTool } from "./read/get_recent_notes.js";
import { registerGetVaultStatsTool } from "./read/get_vault_stats.js";
import { registerResolveAliasTool } from "./read/resolve_alias.js";

export function registerReadTools(server: McpServer, vaultPath: string): void {
  registerSearchNotesTool(server, vaultPath);
  registerGetNoteTool(server, vaultPath);
  registerListNotesTool(server, vaultPath);
  registerGetDailyNoteTool(server, vaultPath);
  registerSearchByFrontmatterTool(server, vaultPath);
  registerGetRecentNotesTool(server, vaultPath);
  registerGetVaultStatsTool(server, vaultPath);
  registerResolveAliasTool(server, vaultPath);
}
