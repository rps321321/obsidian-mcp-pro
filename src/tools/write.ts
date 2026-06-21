import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCreateNote } from "./write/create_note.js";
import { registerAppendToNote } from "./write/append_to_note.js";
import { registerPrependToNote } from "./write/prepend_to_note.js";
import { registerUpdateFrontmatter } from "./write/update_frontmatter.js";
import { registerCreateDailyNote } from "./write/create_daily_note.js";
import { registerMoveNote } from "./write/move_note.js";
import { registerDeleteNote } from "./write/delete_note.js";

export function registerWriteTools(server: McpServer, vaultPath: string): void {
  registerCreateNote(server, vaultPath);
  registerAppendToNote(server, vaultPath);
  registerPrependToNote(server, vaultPath);
  registerUpdateFrontmatter(server, vaultPath);
  registerCreateDailyNote(server, vaultPath);
  registerMoveNote(server, vaultPath);
  registerDeleteNote(server, vaultPath);
}
