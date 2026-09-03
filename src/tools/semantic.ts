import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openEmbeddingStore } from "../lib/embedding-store-handle.js";
import { registerIndexVaultTool } from "./semantic/index_vault.js";
import { registerSearchSemanticTool } from "./semantic/search_semantic.js";
import { registerFindSimilarNotesTool } from "./semantic/find_similar_notes.js";

export function registerSemanticTools(server: McpServer, vaultPath: string): void {
  const store = openEmbeddingStore(vaultPath);
  registerIndexVaultTool(server, vaultPath, store);
  registerSearchSemanticTool(server, vaultPath, store);
  registerFindSimilarNotesTool(server, vaultPath, store);
}
