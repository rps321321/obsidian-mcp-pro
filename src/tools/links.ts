import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote } from "../lib/vault.js";
import { extractWikilinks, resolveWikilink } from "../lib/markdown.js";
import type { LinkInfo, BrokenLink, OrphanNote, GraphNeighbor } from "../types.js";

interface LinkGraphData {
  allNotes: string[];
  outlinks: Map<string, Set<string>>;
  backlinks: Map<string, Set<string>>;
  /** Raw extracted links per note, keyed by source path */
  rawLinks: Map<string, LinkInfo[]>;
  /** Lines content per note for context extraction */
  noteLines: Map<string, string[]>;
}

async function buildLinkGraph(
  vaultPath: string,
  folder?: string,
): Promise<LinkGraphData> {
  const allNotes = await listNotes(vaultPath, folder);
  const outlinks = new Map<string, Set<string>>();
  const backlinks = new Map<string, Set<string>>();
  const rawLinks = new Map<string, LinkInfo[]>();
  const noteLines = new Map<string, string[]>();

  // Initialize sets for all notes
  for (const notePath of allNotes) {
    outlinks.set(notePath, new Set());
    backlinks.set(notePath, new Set());
  }

  for (const notePath of allNotes) {
    let content: string;
    try {
      content = await readNote(vaultPath, notePath);
    } catch {
      console.error(`Failed to read note for link graph: ${notePath}`);
      continue;
    }

    noteLines.set(notePath, content.split("\n"));
    const links = extractWikilinks(content);

    // Fill in source for each link
    for (const link of links) {
      link.source = notePath;
    }
    rawLinks.set(notePath, links);

    const outSet = outlinks.get(notePath) ?? new Set<string>();

    for (const link of links) {
      // Strip heading/block refs for resolution (e.g., "note#heading" -> "note")
      const targetBase = link.target.split("#")[0].trim();
      if (!targetBase) continue;

      const resolved = resolveWikilink(targetBase, notePath, allNotes);
      if (resolved) {
        outSet.add(resolved);

        // Ensure backlinks set exists for target
        if (!backlinks.has(resolved)) {
          backlinks.set(resolved, new Set());
        }
        backlinks.get(resolved)!.add(notePath);
      }
    }

    outlinks.set(notePath, outSet);
  }

  return { allNotes, outlinks, backlinks, rawLinks, noteLines };
}

function findLineWithLink(
  lines: string[],
  linkTarget: string,
): { line: number; content: string } {
  const targetLower = linkTarget.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (lineLower.includes(`[[${targetLower}`) || lineLower.includes(`[[${targetLower}|`)) {
      return { line: i + 1, content: lines[i].trim() };
    }
  }
  // Fallback: search for partial match on just the basename
  const basename = linkTarget.split("/").pop()?.toLowerCase() ?? targetLower;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (lineLower.includes(`[[${basename}`)) {
      return { line: i + 1, content: lines[i].trim() };
    }
  }
  return { line: 0, content: "" };
}

export function registerLinkTools(server: McpServer, vaultPath: string): void {
  // ── get_backlinks ──────────────────────────────────────────────
  server.registerTool(
    "get_backlinks",
    {
      description: "Find all notes that link to a specific note",
      inputSchema: {
        path: z.string().describe("The target note path (relative to vault root)"),
      },
    },
    async ({ path: targetPath }) => {
      try {
        const graph = await buildLinkGraph(vaultPath);

        // Normalize target for comparison
        const targetNormalized = targetPath.replace(/\.md$/i, "").toLowerCase();
        const targetBasename = targetNormalized.split("/").pop() ?? targetNormalized;

        // Find the actual note path that matches the target
        let resolvedTarget: string | null = null;
        for (const notePath of graph.allNotes) {
          const noteNormalized = notePath.replace(/\.md$/i, "").toLowerCase();
          if (noteNormalized === targetNormalized) {
            resolvedTarget = notePath;
            break;
          }
        }

        // Also try basename matching if exact match failed
        if (!resolvedTarget) {
          for (const notePath of graph.allNotes) {
            const noteBasename = notePath
              .replace(/\.md$/i, "")
              .split("/")
              .pop()
              ?.toLowerCase();
            if (noteBasename === targetBasename) {
              resolvedTarget = notePath;
              break;
            }
          }
        }

        if (!resolvedTarget) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No note found matching path: ${targetPath}`,
              },
            ],
          };
        }

        const backlinkSources = graph.backlinks.get(resolvedTarget);
        if (!backlinkSources || backlinkSources.size === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No backlinks found for: ${resolvedTarget}`,
              },
            ],
          };
        }

        const results: { source: string; line: number; context: string }[] = [];

        for (const sourcePath of backlinkSources) {
          const lines = graph.noteLines.get(sourcePath) ?? [];
          // Find the line(s) that contain the link to the target
          const links = graph.rawLinks.get(sourcePath) ?? [];
          const relevantLinks = links.filter((l) => {
            const base = l.target.split("#")[0].trim();
            const resolved = resolveWikilink(base, sourcePath, graph.allNotes);
            return resolved === resolvedTarget;
          });

          if (relevantLinks.length > 0) {
            for (const link of relevantLinks) {
              const lineInfo = findLineWithLink(lines, link.target);
              results.push({
                source: sourcePath,
                line: lineInfo.line,
                context: lineInfo.content,
              });
            }
          } else {
            results.push({ source: sourcePath, line: 0, context: "" });
          }
        }

        // Deduplicate by source+line
        const seen = new Set<string>();
        const deduped = results.filter((r) => {
          const key = `${r.source}:${r.line}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const output = [
          `Backlinks to: ${resolvedTarget}`,
          `Found: ${deduped.length} backlink(s)\n`,
          ...deduped.map((r) => {
            const lineStr = r.line > 0 ? `:${r.line}` : "";
            const contextStr = r.context ? `  → ${r.context}` : "";
            return `- ${r.source}${lineStr}${contextStr}`;
          }),
        ].join("\n");

        return { content: [{ type: "text" as const, text: output }] };
      } catch (err) {
        console.error("get_backlinks error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error finding backlinks: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── get_outlinks ───────────────────────────────────────────────
  server.registerTool(
    "get_outlinks",
    {
      description: "Get all links from a specific note",
      inputSchema: {
        path: z.string().describe("The note path (relative to vault root)"),
      },
    },
    async ({ path: notePath }) => {
      try {
        const allNotes = await listNotes(vaultPath);
        const content = await readNote(vaultPath, notePath);
        const links = extractWikilinks(content);

        const results: { target: string; resolvedPath: string | null; isValid: boolean; isEmbed: boolean }[] = [];

        for (const link of links) {
          const targetBase = link.target.split("#")[0].trim();
          if (!targetBase) continue;

          const resolved = resolveWikilink(targetBase, notePath, allNotes);
          results.push({
            target: link.target,
            resolvedPath: resolved,
            isValid: resolved !== null,
            isEmbed: link.isEmbed,
          });
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No outgoing links found in: ${notePath}`,
              },
            ],
          };
        }

        const valid = results.filter((r) => r.isValid);
        const broken = results.filter((r) => !r.isValid);

        const lines: string[] = [
          `Outgoing links from: ${notePath}`,
          `Total: ${results.length} (${valid.length} valid, ${broken.length} broken)\n`,
        ];

        if (valid.length > 0) {
          lines.push("Valid links:");
          for (const r of valid) {
            const embedPrefix = r.isEmbed ? "📎 " : "";
            lines.push(`  ${embedPrefix}[[${r.target}]] → ${r.resolvedPath}`);
          }
        }

        if (broken.length > 0) {
          lines.push("\nBroken links:");
          for (const r of broken) {
            const embedPrefix = r.isEmbed ? "📎 " : "";
            lines.push(`  ${embedPrefix}[[${r.target}]] → (not found)`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("get_outlinks error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting outlinks: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── find_orphans ───────────────────────────────────────────────
  server.registerTool(
    "find_orphans",
    {
      description: "Find notes that have no incoming or outgoing links",
      inputSchema: {
        includeOutlinksCheck: z
          .boolean()
          .optional()
          .default(true)
          .describe("Also check for notes with no outgoing links"),
      },
    },
    async ({ includeOutlinksCheck }) => {
      try {
        const graph = await buildLinkGraph(vaultPath);

        const noBacklinks: OrphanNote[] = [];
        const noOutlinks: OrphanNote[] = [];
        const fullyIsolated: OrphanNote[] = [];

        for (const notePath of graph.allNotes) {
          const hasBacklinks = (graph.backlinks.get(notePath)?.size ?? 0) > 0;
          const hasOutlinks = (graph.outlinks.get(notePath)?.size ?? 0) > 0;

          if (!hasBacklinks && !hasOutlinks) {
            fullyIsolated.push({ path: notePath, hasOutlinks: false, hasBacklinks: false });
          } else if (!hasBacklinks) {
            noBacklinks.push({ path: notePath, hasOutlinks, hasBacklinks: false });
          } else if (!hasOutlinks && includeOutlinksCheck) {
            noOutlinks.push({ path: notePath, hasOutlinks: false, hasBacklinks });
          }
        }

        const lines: string[] = [
          `Orphan analysis for vault (${graph.allNotes.length} notes total)\n`,
        ];

        lines.push(`Fully isolated (no links in or out): ${fullyIsolated.length}`);
        for (const note of fullyIsolated) {
          lines.push(`  - ${note.path}`);
        }

        lines.push(`\nNo backlinks (not linked by any note): ${noBacklinks.length}`);
        for (const note of noBacklinks) {
          lines.push(`  - ${note.path}`);
        }

        if (includeOutlinksCheck) {
          lines.push(`\nNo outlinks (links to no other notes): ${noOutlinks.length}`);
          for (const note of noOutlinks) {
            lines.push(`  - ${note.path}`);
          }
        }

        const totalOrphans = fullyIsolated.length + noBacklinks.length + (includeOutlinksCheck ? noOutlinks.length : 0);
        lines.push(`\nTotal orphan entries: ${totalOrphans}`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("find_orphans error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error finding orphans: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── find_broken_links ──────────────────────────────────────────
  server.registerTool(
    "find_broken_links",
    {
      description: "Find all wikilinks that point to non-existent notes",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Limit scan to a specific folder"),
      },
    },
    async ({ folder }) => {
      try {
        // Get all notes in vault for resolution, but only scan the folder
        const allNotes = await listNotes(vaultPath);
        const scanNotes = folder ? await listNotes(vaultPath, folder) : allNotes;

        const brokenBySource = new Map<string, BrokenLink[]>();

        for (const notePath of scanNotes) {
          let content: string;
          try {
            content = await readNote(vaultPath, notePath);
          } catch {
            console.error(`Failed to read note for broken link scan: ${notePath}`);
            continue;
          }

          const lines = content.split("\n");
          const links = extractWikilinks(content);

          for (const link of links) {
            const targetBase = link.target.split("#")[0].trim();
            if (!targetBase) continue;

            const resolved = resolveWikilink(targetBase, notePath, allNotes);
            if (!resolved) {
              const lineInfo = findLineWithLink(lines, link.target);
              const broken: BrokenLink = {
                sourcePath: notePath,
                targetLink: link.target,
                line: lineInfo.line,
              };

              if (!brokenBySource.has(notePath)) {
                brokenBySource.set(notePath, []);
              }
              brokenBySource.get(notePath)!.push(broken);
            }
          }
        }

        if (brokenBySource.size === 0) {
          const scopeStr = folder ? ` in folder: ${folder}` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `No broken links found${scopeStr}`,
              },
            ],
          };
        }

        let totalBroken = 0;
        const lines: string[] = [];
        const scopeStr = folder ? ` (folder: ${folder})` : "";
        lines.push(`Broken links report${scopeStr}\n`);

        for (const [sourcePath, brokenLinks] of brokenBySource) {
          lines.push(`${sourcePath}:`);
          for (const bl of brokenLinks) {
            const lineStr = bl.line > 0 ? ` (line ${bl.line})` : "";
            lines.push(`  - [[${bl.targetLink}]]${lineStr}`);
            totalBroken++;
          }
          lines.push("");
        }

        lines.push(`Total: ${totalBroken} broken link(s) across ${brokenBySource.size} file(s)`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("find_broken_links error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error finding broken links: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ── get_graph_neighbors ────────────────────────────────────────
  server.registerTool(
    "get_graph_neighbors",
    {
      description: "Get notes within N link-hops of a given note",
      inputSchema: {
        path: z.string().describe("The starting note path (relative to vault root)"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(1)
          .describe("Maximum number of link-hops (1-5)"),
        direction: z
          .enum(["both", "inbound", "outbound"])
          .optional()
          .default("both")
          .describe("Direction to traverse: inbound (backlinks), outbound (outlinks), or both"),
      },
    },
    async ({ path: startPath, depth, direction }) => {
      try {
        const graph = await buildLinkGraph(vaultPath);

        // Resolve the start path
        const startNormalized = startPath.replace(/\.md$/i, "").toLowerCase();
        let resolvedStart: string | null = null;

        for (const notePath of graph.allNotes) {
          const noteNormalized = notePath.replace(/\.md$/i, "").toLowerCase();
          if (noteNormalized === startNormalized) {
            resolvedStart = notePath;
            break;
          }
        }

        if (!resolvedStart) {
          // Try basename matching
          const startBasename = startNormalized.split("/").pop() ?? startNormalized;
          for (const notePath of graph.allNotes) {
            const noteBasename = notePath
              .replace(/\.md$/i, "")
              .split("/")
              .pop()
              ?.toLowerCase();
            if (noteBasename === startBasename) {
              resolvedStart = notePath;
              break;
            }
          }
        }

        if (!resolvedStart) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No note found matching path: ${startPath}`,
              },
            ],
          };
        }

        // BFS traversal
        const visited = new Map<string, GraphNeighbor>();
        const queue: { path: string; currentDepth: number }[] = [
          { path: resolvedStart, currentDepth: 0 },
        ];
        visited.set(resolvedStart, {
          path: resolvedStart,
          depth: 0,
          direction: "both",
        });

        while (queue.length > 0) {
          const { path: currentPath, currentDepth } = queue.shift()!;
          if (currentDepth >= depth) continue;

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
              const neighborInfo: GraphNeighbor = {
                path: neighbor.path,
                depth: currentDepth + 1,
                direction: neighbor.dir,
              };
              visited.set(neighbor.path, neighborInfo);
              queue.push({ path: neighbor.path, currentDepth: currentDepth + 1 });
            }
          }
        }

        // Remove the start node from results
        visited.delete(resolvedStart);

        if (visited.size === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No neighbors found for: ${resolvedStart} (depth: ${depth}, direction: ${direction})`,
              },
            ],
          };
        }

        // Group by depth level for tree-like output
        const byDepth = new Map<number, GraphNeighbor[]>();
        for (const neighbor of visited.values()) {
          if (!byDepth.has(neighbor.depth)) {
            byDepth.set(neighbor.depth, []);
          }
          byDepth.get(neighbor.depth)!.push(neighbor);
        }

        const lines: string[] = [
          `Graph neighbors of: ${resolvedStart}`,
          `Direction: ${direction} | Max depth: ${depth} | Found: ${visited.size} note(s)\n`,
          resolvedStart,
        ];

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
            lines.push(`${indent}${arrow} ${neighbor.path} (depth ${d})`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("get_graph_neighbors error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting graph neighbors: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
