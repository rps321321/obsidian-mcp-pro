import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIndexVaultTool } from "./semantic/index_vault.js";
import { registerSearchSemanticTool } from "./semantic/search_semantic.js";
import { registerFindSimilarNotesTool } from "./semantic/find_similar_notes.js";

export function registerSemanticTools(server: McpServer, vaultPath: string): void {
  registerIndexVaultTool(server, vaultPath);
  registerSearchSemanticTool(server, vaultPath);
  registerFindSimilarNotesTool(server, vaultPath);
}
