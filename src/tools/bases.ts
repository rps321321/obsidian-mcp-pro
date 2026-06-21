import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListBases } from "./bases/list-bases.js";
import { registerReadBase } from "./bases/read-base.js";
import { registerQueryBase } from "./bases/query-base.js";
export { textResult, untrustedTextResult, errorResult, displayBaseValue, untrustedBaseBlock } from "./bases/shared.js";

export function registerBaseTools(server: McpServer, vaultPath: string): void {
  registerListBases(server, vaultPath);
  registerReadBase(server, vaultPath);
  registerQueryBase(server, vaultPath);
}
