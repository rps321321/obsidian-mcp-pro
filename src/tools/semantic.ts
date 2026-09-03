import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  openEmbeddingStore,
  type EmbeddingStore,
} from "../lib/embedding-store-handle.js";
import { registerIndexVaultTool } from "./semantic/index_vault.js";
import { registerSearchSemanticTool } from "./semantic/search_semantic.js";
import { registerFindSimilarNotesTool } from "./semantic/find_similar_notes.js";

export function registerSemanticTools(
  server: McpServer,
  vaultPath: string,
  store: EmbeddingStore = openEmbeddingStore(vaultPath)
): void {
  registerIndexVaultTool(server, vaultPath, store);
  registerSearchSemanticTool(server, vaultPath, store);
  registerFindSimilarNotesTool(server, vaultPath, store);
}
