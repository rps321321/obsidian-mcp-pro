import path from "path";
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
  if (store.vaultPath !== path.resolve(vaultPath)) {
    throw new Error("EmbeddingStore vault does not match semantic tool vault");
  }
  registerIndexVaultTool(server, vaultPath, store);
  registerSearchSemanticTool(server, vaultPath, store);
  registerFindSimilarNotesTool(server, vaultPath, store);
}
