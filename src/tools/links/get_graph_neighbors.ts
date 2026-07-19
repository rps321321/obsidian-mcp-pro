import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphNeighbor } from "../../types.js";
import { defineTool, richText, error } from "../../lib/tool-seam.js";
import {
  buildLinkGraph,
  resolveGraphInputPath,
  displayLinkValue,
} from "./shared.js";

export function registerGetGraphNeighbors(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_graph_neighbors",
      title: "Get Graph Neighbors",
      description:
        "Traverse the wikilink graph outward from a starting note and return every note reachable within N hops, grouped by depth level with an indented tree visualization. Each neighbor is tagged with its hop distance and direction (inbound = reached via backlink, outbound = reached via outlink). Use to explore a topic cluster, map a note's local neighborhood, or find related notes beyond direct links. Accepts paths with or without .md extension.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Starting note path relative to vault root (e.g., 'projects/alpha.md'). Extension optional; falls back to basename match."
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .default(1)
          .describe(
            "Maximum link-hops to traverse from the start note (1-3, default: 1). Higher values explore exponentially more notes."
          ),
        direction: z
          .enum(["both", "inbound", "outbound"])
          .optional()
          .default("both")
          .describe(
            "Traversal direction: 'outbound' follows outlinks the start note points to, 'inbound' follows backlinks pointing at the start note, 'both' follows either (default)"
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(200)
          .describe(
            "Maximum neighbor notes to return (1-1000, default: 200). Traversal stops early when this cap is reached and a truncation notice is appended."
          ),
      },
    },
    async ({ path: startPath, depth, direction, maxResults }) => {
      const graph = await buildLinkGraph(vaultPath);

      const resolvedStart = resolveGraphInputPath(graph, startPath);

      if (!resolvedStart) {
        return error(
          `No note found matching path: ${displayLinkValue(startPath)}`
        );
      }

      // BFS traversal with maxResults cap to prevent explosion at higher depths
      const visited = new Map<string, GraphNeighbor>();
      const queue: { path: string; currentDepth: number }[] = [
        { path: resolvedStart, currentDepth: 0 },
      ];
      visited.set(resolvedStart, {
        path: resolvedStart,
        depth: 0,
        direction: "both",
      });
      // Track neighbor count separately (visited includes the start node)
      let neighborCount = 0;
      let truncated = false;

      while (queue.length > 0) {
        const { path: currentPath, currentDepth } = queue.shift()!;
        if (currentDepth >= depth) continue;
        if (truncated) break;

        const neighbors: { path: string; dir: "inbound" | "outbound" }[] = [];

        if (direction === "outbound" || direction === "both") {
          const outs = graph.outlinks.get(currentPath);
          if (outs) {
            for (const target of outs) {
              neighbors.push({ path: target, dir: "outbound" });
            }
          }
        }

        if (direction === "inbound" || direction === "both") {
          const ins = graph.backlinks.get(currentPath);
          if (ins) {
            for (const source of ins) {
              neighbors.push({ path: source, dir: "inbound" });
            }
          }
        }

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor.path)) {
            if (neighborCount >= maxResults) {
              truncated = true;
              break;
            }
            const neighborInfo: GraphNeighbor = {
              path: neighbor.path,
              depth: currentDepth + 1,
              direction: neighbor.dir,
            };
            visited.set(neighbor.path, neighborInfo);
            neighborCount++;
            queue.push({ path: neighbor.path, currentDepth: currentDepth + 1 });
          }
        }
      }

      // Remove the start node from results
      visited.delete(resolvedStart);

      if (visited.size === 0) {
        return richText("get_graph_neighbors start path", (b) => {
          b.trusted("No neighbors found for:");
          b.untrusted(
            "get_graph_neighbors start path",
            displayLinkValue(resolvedStart),
            "  "
          );
          b.trusted(`(depth: ${depth}, direction: ${direction})`);
        });
      }

      // Group by depth level for tree-like output
      const byDepth = new Map<number, GraphNeighbor[]>();
      for (const neighbor of visited.values()) {
        if (!byDepth.has(neighbor.depth)) {
          byDepth.set(neighbor.depth, []);
        }
        byDepth.get(neighbor.depth)!.push(neighbor);
      }

      const truncatedStr = truncated ? " (TRUNCATED)" : "";
      const pathTreeLines = [displayLinkValue(resolvedStart)];

      const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);
      for (const d of sortedDepths) {
        const neighbors = byDepth.get(d)!;
        neighbors.sort((a, b) => a.path.localeCompare(b.path));

        for (const neighbor of neighbors) {
          const indent = "  ".repeat(d);
          const arrow =
            neighbor.direction === "inbound"
              ? "←"
              : neighbor.direction === "outbound"
                ? "→"
                : "↔";
          pathTreeLines.push(
            `${indent}${arrow} ${displayLinkValue(neighbor.path)} (depth ${d})`
          );
        }
      }

      return richText("get_graph_neighbors paths", (b) => {
        b.trusted("Graph neighbors of:");
        b.untrusted(
          "get_graph_neighbors start path",
          displayLinkValue(resolvedStart),
          "  "
        );
        b.trusted(
          `Direction: ${direction} | Max depth: ${depth} | Found: ${visited.size} note(s)${truncatedStr}\n`
        );
        b.trusted("Path tree:");
        b.untrusted("get_graph_neighbors path tree", pathTreeLines.join("\n"));

        if (truncated) {
          b.trusted(
            `\nResults truncated at ${maxResults} neighbors. Reduce depth or narrow direction to see the full graph.`
          );
        }
      });
    }
  );
}
