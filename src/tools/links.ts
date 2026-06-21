import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetBacklinks } from "./links/get_backlinks.js";
import { registerGetOutlinks } from "./links/get_outlinks.js";
import { registerFindOrphans } from "./links/find_orphans.js";
import { registerFindBrokenLinks } from "./links/find_broken_links.js";
import { registerGetGraphNeighbors } from "./links/get_graph_neighbors.js";

export function registerLinkTools(server: McpServer, vaultPath: string): void {
  registerGetBacklinks(server, vaultPath);
  registerGetOutlinks(server, vaultPath);
  registerFindOrphans(server, vaultPath);
  registerFindBrokenLinks(server, vaultPath);
  registerGetGraphNeighbors(server, vaultPath);
}
