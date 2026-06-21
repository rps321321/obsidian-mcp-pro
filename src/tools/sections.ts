import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUpdateSectionTool } from "./sections/update_section.js";
import { registerInsertAtSectionTool } from "./sections/insert_at_section.js";
import { registerListSectionsTool } from "./sections/list_sections.js";
import { registerReplaceInNoteTool } from "./sections/replace_in_note.js";
import { registerEditBlockTool } from "./sections/edit_block.js";

export function registerSectionTools(server: McpServer, vaultPath: string): void {
  registerUpdateSectionTool(server, vaultPath);
  registerInsertAtSectionTool(server, vaultPath);
  registerListSectionsTool(server, vaultPath);
  registerReplaceInNoteTool(server, vaultPath);
  registerEditBlockTool(server, vaultPath);
}
