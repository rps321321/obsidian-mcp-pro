import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListTags } from "./tags/list_tags.js";
import { registerSearchByTag } from "./tags/search_by_tag.js";
import { registerRenameTag } from "./tags/rename_tag.js";

export function registerTagTools(server: McpServer, vaultPath: string): void {
  registerListTags(server, vaultPath);
  registerSearchByTag(server, vaultPath);
  registerRenameTag(server, vaultPath);
}
