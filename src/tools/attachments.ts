import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListAttachments } from "./attachments/list_attachments.js";
import { registerFindUnusedAttachments } from "./attachments/find_unused_attachments.js";
import { registerGetAttachment } from "./attachments/get_attachment.js";

export function registerAttachmentTools(server: McpServer, vaultPath: string): void {
  registerListAttachments(server, vaultPath);
  registerFindUnusedAttachments(server, vaultPath);
  registerGetAttachment(server, vaultPath);
}
