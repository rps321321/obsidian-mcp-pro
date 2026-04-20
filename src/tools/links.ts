import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote, getNoteStats } from "../lib/vault.js";
import { extractWikilinks, resolveWikilink, extractAliases } from "../lib/markdown.js";
import { sanitizeError } from "../lib/errors.js";
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

// Per-vault+folder cache. Invalidated when any note's mtime changes,
// the file set changes, or after 30 seconds (defensive TTL).
interface CachedGraph {
  data: LinkGraphData;
  /** Fingerprint folds every note's path+mtime, not just count+max. Prevents
   *  stale hits when a note is added+deleted within one second, or when an
   *  edit happens to restore the previous max-mtime. */
  fingerprint: string;
  cachedAt: number;
}
const GRAPH_CACHE_TTL_MS = 30_000;
const GRAPH_CACHE_MAX_ENTRIES = 32;
const graphCache = new Map<string, CachedGraph>();

// Map iteration order = insertion order; delete+set to refresh recency.
function setGraphCache(key: string, entry: CachedGraph): void {
  if (graphCache.has(key)) graphCache.delete(key);
  graphCache.set(key, entry);
  while (graphCache.size > GRAPH_CACHE_MAX_ENTRIES) {
    const oldest = graphCache.keys().next().value;
    if (oldest === undefined) break;
    graphCache.delete(oldest);
  }
}

async function fingerprintVault(
  vaultPath: string,
  notes: string[],
): Promise<string> {
  // Accumulate a 32-bit FNV-1a hash over "<sortedPath>|<mtimeMs>;" per note.
  // Catches add+delete churn and mtime-restoring edits that count+max-mtime
  // alone would miss.
  const sorted = [...notes].sort();
  let hash = 0x811c9dc5;
  const CONCURRENCY = 16;
  for (let i = 0; i < sorted.length; i += CONCURRENCY) {
    const slice = sorted.slice(i, i + CONCURRENCY);
    const stats = await Promise.all(
      slice.map((n) => getNoteStats(vaultPath, n).catch(() => null)),
    );
    for (let j = 0; j < slice.length; j++) {
      const mtime = stats[j]?.modified?.getTime() ?? 0;
      const entry = `${slice[j]}|${mtime};`;
      for (let k = 0; k < entry.length; k++) {
        hash ^= entry.charCodeAt(k);
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return `${sorted.length}:${(hash >>> 0).toString(16)}`;
}

async function buildLinkGraph(
  vaultPath: string,
  folder?: string,
): Promise<LinkGraphData> {
  const cacheKey = `${vaultPath}::${folder ?? ""}`;
  const cached = graphCache.get(cacheKey);
  const allNotes = await listNotes(vaultPath, folder);

  if (cached && Date.now() - cached.cachedAt < GRAPH_CACHE_TTL_MS) {
    const fp = await fingerprintVault(vaultPath, allNotes);
    if (fp === cached.fingerprint) {
      // Refresh recency so hot entries aren't evicted under LRU pressure.
      setGraphCache(cacheKey, cached);
      return cached.data;
    }
  }

  const outlinks = new Map<string, Set<string>>();
  const backlinks = new Map<string, Set<string>>();
  const rawLinks = new Map<string, LinkInfo[]>();
  const noteLines = new Map<string, string[]>();

  // Initialize sets for all notes
  for (const notePath of allNotes) {
    outlinks.set(notePath, new Set());
    backlinks.set(notePath, new Set());
  }

  // Read notes in parallel with a concurrency cap
  const CONCURRENCY = 16;
  const noteContents = new Map<string, string>();
  for (let i = 0; i < allNotes.length; i += CONCURRENCY) {
    const slice = allNotes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (p) => {
        try {
          return [p, await readNote(vaultPath, p)] as const;
        } catch {
          console.error(`Failed to read note for link graph: ${p}`);
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) noteContents.set(r[0], r[1]);
    }
  }

  // Build alias map first so any note can link to any other by alias
  // (e.g. `[[My Project]]` → note whose frontmatter has `aliases: [My Project]`).
  // Last-writer-wins on collisions; logged via console.error to surface dup
  // aliases during development.
  const aliasMap = new Map<string, string>();
  for (const notePath of allNotes) {
    const content = noteContents.get(notePath);
    if (content === undefined) continue;
    for (const alias of extractAliases(content)) {
      const key = alias.toLowerCase();
      if (!key) continue;
      if (aliasMap.has(key) && aliasMap.get(key) !== notePath) {
        console.error(`Duplicate alias "${alias}" — used by both ${aliasMap.get(key)} and ${notePath}`);
      }
      aliasMap.set(key, notePath);
    }
  }

  for (const notePath of allNotes) {
    const content = noteContents.get(notePath);
    if (content === undefined) continue;

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

      const resolved = resolveWikilink(targetBase, notePath, allNotes, { aliasMap });
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

  const data: LinkGraphData = { allNotes, outlinks, backlinks, rawLinks, noteLines };
  const fingerprint = await fingerprintVault(vaultPath, allNotes);
  setGraphCache(cacheKey, { data, fingerprint, cachedAt: Date.now() });
  return data;
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
  function errorResult(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true as const };
  }

  // ── get_backlinks ──────────────────────────────────────────────
  server.registerTool(
    "get_backlinks",
    {
      title: "Get Backlinks",
      description:
        "List all notes that contain a wikilink pointing to the target note. Each result includes the source note path, line number, and the surrounding line text for context. Use to understand which notes reference a topic, or to assess the impact of renaming or deleting a note. Accepts paths with or without .md extension; falls back to basename matching if exact match fails.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Target note path relative to vault root (e.g., 'folder/note.md' or 'note'). Extension optional."),
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
          return errorResult(`No note found matching path: ${targetPath}`);
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
        return errorResult(`Error finding backlinks: ${sanitizeError(err)}`);
      }
    },
  );

  // ── get_outlinks ───────────────────────────────────────────────
  server.registerTool(
    "get_outlinks",
    {
      title: "Get Outlinks",
      description:
        "List every outgoing wikilink from a note, partitioned into valid links (resolve to an existing note), broken links (target not found), and file embeds (![[...]]). Returns the raw link text and resolved paths. Use to audit a note's references, detect broken links, or follow downstream dependencies.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Source note path relative to vault root (e.g., 'folder/note.md'). Extension optional."),
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
        return errorResult(`Error getting outlinks: ${sanitizeError(err)}`);
      }
    },
  );

  // ── find_orphans ───────────────────────────────────────────────
  server.registerTool(
    "find_orphans",
    {
      title: "Find Orphan Notes",
      description:
        "Identify disconnected notes in the vault's link graph, classified into three groups: fully isolated (no links in or out), no-backlinks (nothing links to them), and no-outlinks (they link to nothing). Returns counts per category and an example list per category, capped by maxResults. Use to surface abandoned notes, missing hub pages, or candidates for archiving.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        includeOutlinksCheck: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), also report notes with no outgoing links; if false, only report fully-isolated notes and notes with no backlinks."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .default(200)
          .describe("Maximum total note paths to list across all categories (1-5000, default: 200). Full counts are always reported regardless."),
      },
    },
    async ({ includeOutlinksCheck, maxResults }) => {
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

        // Apply maxResults cap across all categories
        let remaining = maxResults;

        const cappedIsolated = fullyIsolated.slice(0, remaining);
        remaining -= cappedIsolated.length;
        const cappedNoBacklinks = noBacklinks.slice(0, Math.max(0, remaining));
        remaining -= cappedNoBacklinks.length;
        const cappedNoOutlinks = includeOutlinksCheck ? noOutlinks.slice(0, Math.max(0, remaining)) : [];

        const lines: string[] = [
          `Orphan analysis for vault (${graph.allNotes.length} notes total)\n`,
        ];

        lines.push(`Fully isolated (no links in or out): ${fullyIsolated.length}`);
        for (const note of cappedIsolated) {
          lines.push(`  - ${note.path}`);
        }
        if (cappedIsolated.length < fullyIsolated.length) {
          lines.push(`  ... and ${fullyIsolated.length - cappedIsolated.length} more`);
        }

        lines.push(`\nNo backlinks (not linked by any note): ${noBacklinks.length}`);
        for (const note of cappedNoBacklinks) {
          lines.push(`  - ${note.path}`);
        }
        if (cappedNoBacklinks.length < noBacklinks.length) {
          lines.push(`  ... and ${noBacklinks.length - cappedNoBacklinks.length} more`);
        }

        if (includeOutlinksCheck) {
          lines.push(`\nNo outlinks (links to no other notes): ${noOutlinks.length}`);
          for (const note of cappedNoOutlinks) {
            lines.push(`  - ${note.path}`);
          }
          if (cappedNoOutlinks.length < noOutlinks.length) {
            lines.push(`  ... and ${noOutlinks.length - cappedNoOutlinks.length} more`);
          }
        }

        const totalOrphans = fullyIsolated.length + noBacklinks.length + (includeOutlinksCheck ? noOutlinks.length : 0);
        lines.push(`\nTotal orphan entries: ${totalOrphans}`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("find_orphans error:", err);
        return errorResult(`Error finding orphans: ${sanitizeError(err)}`);
      }
    },
  );

  // ── find_broken_links ──────────────────────────────────────────
  server.registerTool(
    "find_broken_links",
    {
      title: "Find Broken Links",
      description:
        "Scan notes for wikilinks ([[target]]) whose target does not resolve to any existing note in the vault. Returns a per-source report grouping each note with its broken link text and line numbers, plus a total count. Use after renaming, moving, or deleting notes to catch dangling references. Resolution uses the whole vault even when scanning a single folder, so only truly unresolvable links are reported.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Restrict the scan to notes within this folder (resolution still uses the entire vault). Omit to scan every note."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .default(200)
          .describe("Maximum broken link entries to show (1-5000, default: 200). Grouped by source note. Remaining matches are summarized."),
      },
    },
    async ({ folder, maxResults }) => {
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
        for (const brokenLinks of brokenBySource.values()) {
          totalBroken += brokenLinks.length;
        }

        const lines: string[] = [];
        const scopeStr = folder ? ` (folder: ${folder})` : "";
        lines.push(`Broken links report${scopeStr}\n`);

        let shown = 0;
        for (const [sourcePath, brokenLinks] of brokenBySource) {
          if (shown >= maxResults) break;
          lines.push(`${sourcePath}:`);
          for (const bl of brokenLinks) {
            if (shown >= maxResults) break;
            const lineStr = bl.line > 0 ? ` (line ${bl.line})` : "";
            lines.push(`  - [[${bl.targetLink}]]${lineStr}`);
            shown++;
          }
          lines.push("");
        }

        if (shown < totalBroken) {
          lines.push(`... and ${totalBroken - shown} more broken link(s) not shown`);
        }
        lines.push(`Total: ${totalBroken} broken link(s) across ${brokenBySource.size} file(s)`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("find_broken_links error:", err);
        return errorResult(`Error finding broken links: ${sanitizeError(err)}`);
      }
    },
  );

  // ── get_graph_neighbors ────────────────────────────────────────
  server.registerTool(
    "get_graph_neighbors",
    {
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
          .describe("Starting note path relative to vault root (e.g., 'projects/alpha.md'). Extension optional; falls back to basename match."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(1)
          .describe("Maximum link-hops to traverse from the start note (1-5, default: 1). Higher values explore further but can return many notes."),
        direction: z
          .enum(["both", "inbound", "outbound"])
          .optional()
          .default("both")
          .describe("Traversal direction: 'outbound' follows outlinks the start note points to, 'inbound' follows backlinks pointing at the start note, 'both' follows either (default)"),
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
          return errorResult(`No note found matching path: ${startPath}`);
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
        return errorResult(`Error getting graph neighbors: ${sanitizeError(err)}`);
      }
    },
  );
}
