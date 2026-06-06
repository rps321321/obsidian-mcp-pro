import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "path";
import { z } from "zod";
import { listNotes, getNoteStats, getVaultRootRealPath } from "../lib/vault.js";
import { readAllCached } from "../lib/index-cache.js";
import { extractWikilinks, extractAliases } from "../lib/markdown.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../lib/tool-output.js";
import { log } from "../lib/logger.js";
import type { LinkInfo, BrokenLink, OrphanNote, GraphNeighbor } from "../types.js";

interface LinkGraphData {
  allNotes: string[];
  outlinks: Map<string, Set<string>>;
  backlinks: Map<string, Set<string>>;
  /** Raw extracted links per note, keyed by source path */
  rawLinks: Map<string, LinkInfo[]>;
  /** Lines content per note for context extraction */
  noteLines: Map<string, string[]>;
  /** Lowercased alias → note path. Needed by display-pass callers
   *  (get_backlinks, get_outlinks) so resolveWikilink can find alias-only
   *  targets the build pass already indexed. */
  aliasMap: Map<string, string>;
  /** Unresolved wikilinks per note, keyed by source path. */
  brokenLinks: Map<string, BrokenLink[]>;
  /** Normalized caller path -> graph note path. Exact keys win over basename keys. */
  sourceLookup: Map<string, string>;
  pathIndex: NotePathIndex;
  outlinkDetails: Map<string, OutlinkDetail[]>;
}

interface NotePathIndex {
  exact: Map<string, string>;
  basename: Map<string, string[]>;
}

interface OutlinkDetail {
  target: string;
  resolvedPath: string | null;
  isValid: boolean;
  isEmbed: boolean;
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
const GRAPH_FINGERPRINT_CONCURRENCY = 64;
const REDACTED_ALIAS_LABEL = "<vault alias>";

function displayLinkValue(value: string): string {
  return escapeControlChars(value);
}

function untrustedLinkBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

function pushUntrustedLinkPathRows(
  lines: string[],
  label: string,
  rows: readonly string[],
  indent = "",
): boolean {
  if (rows.length === 0) return false;
  lines.push(untrustedLinkBlock(label, rows.map(displayLinkValue).join("\n"), indent));
  return true;
}

function pushUntrustedLinkTarget(
  lines: string[],
  label: string,
  target: string,
  indent: string,
): void {
  lines.push(`${indent}Target:`);
  lines.push(untrustedLinkBlock(label, displayLinkValue(target), `${indent}  `));
}

function textWithUntrustedMeta(text: string, label: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

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

function fingerprintFromMtimes(
  notes: string[],
  mtimes: ReadonlyMap<string, number>,
): string {
  // Accumulate a 32-bit FNV-1a hash over "<sortedPath>|<mtimeMs>;" per note.
  // Catches add+delete churn and mtime-restoring edits that count+max-mtime
  // alone would miss.
  const sorted = [...notes].sort();
  let hash = 0x811c9dc5;
  for (const note of sorted) {
    const mtime = mtimes.get(note) ?? 0;
    const entry = `${note}|${mtime};`;
    for (let k = 0; k < entry.length; k++) {
      hash ^= entry.charCodeAt(k);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${sorted.length}:${(hash >>> 0).toString(16)}`;
}

async function fingerprintVault(
  vaultPath: string,
  notes: string[],
): Promise<string> {
  const mtimes = new Map<string, number>();
  const sorted = [...notes].sort();
  const realVaultRoot = await getVaultRootRealPath(vaultPath);
  for (let i = 0; i < sorted.length; i += GRAPH_FINGERPRINT_CONCURRENCY) {
    const slice = sorted.slice(i, i + GRAPH_FINGERPRINT_CONCURRENCY);
    const stats = await Promise.all(
      slice.map((n) => getNoteStats(vaultPath, n, { realVaultRoot }).catch(() => null)),
    );
    for (let j = 0; j < slice.length; j++) {
      const mtime = stats[j]?.modified?.getTime() ?? 0;
      mtimes.set(slice[j]!, mtime);
    }
  }
  return fingerprintFromMtimes(sorted, mtimes);
}

function buildSourceLookup(notes: string[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const notePath of notes) {
    const normalized = notePath.replace(/\.md$/i, "").toLowerCase();
    const exactKey = `exact:${normalized}`;
    if (!lookup.has(exactKey)) lookup.set(exactKey, notePath);
    const basename = normalized.split("/").pop() ?? normalized;
    if (!lookup.has(`base:${basename}`)) {
      lookup.set(`base:${basename}`, notePath);
    }
  }
  return lookup;
}

function sharedPathDepth(a: string, b: string): number {
  const as = a.toLowerCase().split("/");
  const bs = b.toLowerCase().split("/");
  let i = 0;
  const max = Math.min(as.length, bs.length);
  while (i < max && as[i] === bs[i]) i++;
  return i;
}

function buildNotePathIndex(notes: string[]): NotePathIndex {
  const exact = new Map<string, string>();
  const basename = new Map<string, string[]>();
  for (const notePath of notes) {
    const normalized = notePath.replace(/\.md$/i, "").toLowerCase();
    if (!exact.has(normalized)) exact.set(normalized, notePath);

    const noteBasename = path
      .basename(notePath, path.extname(notePath))
      .toLowerCase();
    const matches = basename.get(noteBasename);
    if (matches) {
      matches.push(notePath);
    } else {
      basename.set(noteBasename, [notePath]);
    }
  }
  return { exact, basename };
}

function resolveWikilinkWithIndex(
  link: string,
  currentNotePath: string,
  allNotePaths: string[],
  index: NotePathIndex,
  aliasMap: Map<string, string>,
): string | null {
  const cleanLink = link.split("#")[0]!.split("^")[0]!.trim();
  if (!cleanLink) return null;

  const normalizedLink = cleanLink.replace(/\.md$/i, "");
  const normalizedLinkLower = normalizedLink.toLowerCase();

  const exact = index.exact.get(normalizedLinkLower);
  if (exact) return exact;

  if (normalizedLink.includes("/")) {
    const suffixCandidates: string[] = [];
    for (const notePath of allNotePaths) {
      const withoutExt = notePath.replace(/\.md$/i, "").toLowerCase();
      if (withoutExt.endsWith(normalizedLinkLower)) {
        const prefix = withoutExt.slice(0, withoutExt.length - normalizedLinkLower.length);
        if (prefix === "" || prefix.endsWith("/")) suffixCandidates.push(notePath);
      }
    }
    if (suffixCandidates.length === 1) return suffixCandidates[0]!;
    if (suffixCandidates.length > 1) {
      return nearestNotePath(currentNotePath, suffixCandidates);
    }
  }

  const linkBasename = path.basename(normalizedLink).toLowerCase();
  const basenameCandidates = index.basename.get(linkBasename) ?? [];
  if (basenameCandidates.length === 1) return basenameCandidates[0]!;
  if (basenameCandidates.length > 1) {
    return nearestNotePath(currentNotePath, basenameCandidates);
  }

  return aliasMap.get(normalizedLinkLower) ?? null;
}

function nearestNotePath(currentNotePath: string, candidates: readonly string[]): string {
  const sourceDir = path.dirname(currentNotePath).replace(/\\/g, "/");
  return [...candidates].sort((a, b) => {
    const da = sharedPathDepth(sourceDir, path.dirname(a).replace(/\\/g, "/"));
    const db = sharedPathDepth(sourceDir, path.dirname(b).replace(/\\/g, "/"));
    if (da !== db) return db - da;
    return a.length - b.length;
  })[0]!;
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
  const brokenLinks = new Map<string, BrokenLink[]>();
  const outlinkDetails = new Map<string, OutlinkDetail[]>();

  // Initialize sets for all notes
  for (const notePath of allNotes) {
    outlinks.set(notePath, new Set());
    backlinks.set(notePath, new Set());
  }

  // Read notes via the shared mtime cache so repeated graph builds (and
  // overlapping search_notes / get_tags scans) skip re-reads.
  const { contents: noteContents, mtimes } = await readAllCached(
    vaultPath,
    allNotes,
    (note, err) => {
      log.warn("link graph: note read failed", { note, err });
    },
  );

  // Build alias map first so any note can link to any other by alias
  // (e.g. `[[My Project]]` → note whose frontmatter has `aliases: [My Project]`).
  // Last-writer-wins on collisions; logged at warn level so operators and
  // connected MCP clients can notice the duplicate during vault cleanup.
  const aliasMap = new Map<string, string>();
  for (const notePath of allNotes) {
    const content = noteContents.get(notePath);
    if (content === undefined) continue;
    for (const alias of extractAliases(content)) {
      const key = alias.toLowerCase();
      if (!key) continue;
      const prior = aliasMap.get(key);
      if (prior && prior !== notePath) {
        log.warn("Duplicate alias", { alias: REDACTED_ALIAS_LABEL, notes: [prior, notePath] });
      }
      aliasMap.set(key, notePath);
    }
  }
  const pathIndex = buildNotePathIndex(allNotes);

  for (const notePath of allNotes) {
    const content = noteContents.get(notePath);
    if (content === undefined) continue;

    const lines = content.split("\n");
    noteLines.set(notePath, lines);
    const links = extractWikilinks(content);

    // Fill in source for each link
    for (const link of links) {
      link.source = notePath;
    }
    rawLinks.set(notePath, links);

    const outSet = outlinks.get(notePath) ?? new Set<string>();
    const details: OutlinkDetail[] = [];

    for (const link of links) {
      // Strip heading/block refs for resolution (e.g., "note#heading" -> "note")
      const targetBase = link.target.split("#")[0]!.trim();
      if (!targetBase) continue;

      const resolved = resolveWikilinkWithIndex(targetBase, notePath, allNotes, pathIndex, aliasMap);
      details.push({
        target: link.target,
        resolvedPath: resolved,
        isValid: resolved !== null,
        isEmbed: link.isEmbed,
      });
      if (resolved) {
        outSet.add(resolved);

        // Ensure backlinks set exists for target
        if (!backlinks.has(resolved)) {
          backlinks.set(resolved, new Set());
        }
        backlinks.get(resolved)!.add(notePath);
      } else {
        const lineInfo = findLineWithLink(lines, link.target);
        const broken: BrokenLink = {
          sourcePath: notePath,
          targetLink: link.target,
          line: lineInfo.line,
        };
        if (!brokenLinks.has(notePath)) {
          brokenLinks.set(notePath, []);
        }
        brokenLinks.get(notePath)!.push(broken);
      }
    }

    outlinks.set(notePath, outSet);
    outlinkDetails.set(notePath, details);
  }

  const data: LinkGraphData = {
    allNotes,
    outlinks,
    backlinks,
    rawLinks,
    noteLines,
    aliasMap,
    brokenLinks,
    sourceLookup: buildSourceLookup(allNotes),
    pathIndex,
    outlinkDetails,
  };
  const fingerprint = fingerprintFromMtimes(allNotes, mtimes);
  setGraphCache(cacheKey, { data, fingerprint, cachedAt: Date.now() });
  return data;
}

function findLineWithLink(
  lines: string[],
  linkTarget: string,
): { line: number; content: string } {
  const targetLower = linkTarget.toLowerCase();
  // Exact match: the character after the link name must be ]], |, or #
  // to avoid prefix false positives (e.g. [[note]] matching [[notebook]]).
  const exactSuffixes = ["]]", "|", "#"];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineLower = line.toLowerCase();
    const idx = lineLower.indexOf(`[[${targetLower}`);
    if (idx !== -1) {
      const afterPos = idx + 2 + targetLower.length;
      if (afterPos <= lineLower.length && exactSuffixes.some((s) => lineLower.startsWith(s, afterPos))) {
        return { line: i + 1, content: line.trim() };
      }
    }
  }
  // Fallback: search for exact match on just the basename
  const basename = linkTarget.split("/").pop()?.toLowerCase() ?? targetLower;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineLower = line.toLowerCase();
    const idx = lineLower.indexOf(`[[${basename}`);
    if (idx !== -1) {
      const afterPos = idx + 2 + basename.length;
      if (afterPos <= lineLower.length && exactSuffixes.some((s) => lineLower.startsWith(s, afterPos))) {
        return { line: i + 1, content: line.trim() };
      }
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
          .max(500)
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
          return errorResult(`No note found matching path: ${displayLinkValue(targetPath)}`);
        }

        const backlinkSources = graph.backlinks.get(resolvedTarget);
        if (!backlinkSources || backlinkSources.size === 0) {
          const text = [
            "No backlinks found for:",
            untrustedLinkBlock("get_backlinks target path", displayLinkValue(resolvedTarget), "  "),
          ].join("\n");
          return textWithUntrustedMeta(text, "get_backlinks target path");
        }

        const results: { source: string; line: number; context: string }[] = [];

        for (const sourcePath of backlinkSources) {
          const lines = graph.noteLines.get(sourcePath) ?? [];
          // Find the line(s) that contain the link to the target
          const links = graph.rawLinks.get(sourcePath) ?? [];
          const relevantLinks = links.filter((l) => {
            const base = l.target.split("#")[0]!.trim();
            // Pass aliasMap so alias-only matches (e.g. `[[My Project]]`
            // pointing at a note whose frontmatter declares that alias)
            // resolve here exactly as they did during graph build. Without
            // it, the source slipped into the backlink set during build but
            // produced an empty line/context in this display pass.
            const resolved = resolveWikilinkWithIndex(
              base,
              sourcePath,
              graph.allNotes,
              graph.pathIndex,
              graph.aliasMap,
            );
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

        const outputLines = [
          "Backlinks to:",
          untrustedLinkBlock("get_backlinks target path", displayLinkValue(resolvedTarget), "  "),
          `Found: ${deduped.length} backlink(s)\n`,
        ];
        for (const r of deduped) {
          const lineStr = r.line > 0 ? `:${r.line}` : "";
          outputLines.push("Source:");
          outputLines.push(untrustedLinkBlock(
            "get_backlinks source path",
            `${displayLinkValue(r.source)}${lineStr}`,
            "  ",
          ));
          if (r.context) {
            outputLines.push(indentBlock(
              `→ ${formatUntrustedVaultContent(
                `backlink context: ${r.source}:${r.line}`,
                displayLinkValue(r.context),
              )}`,
              "  ",
            ));
          }
        }
        const output = outputLines.join("\n");

        return {
          content: [{
            type: "text" as const,
            text: output,
            _meta: untrustedVaultContentMeta("get_backlinks paths and context"),
          }],
        };
      } catch (err) {
        log.error("get_backlinks failed", { tool: "get_backlinks", err: err as Error });
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
          .max(500)
          .describe("Source note path relative to vault root (e.g., 'folder/note.md'). Extension optional."),
      },
    },
    async ({ path: notePath }) => {
      try {
        // Route through the shared link graph so resolution uses the same
        // alias map the rest of the link tools rely on, and so the heavy
        // read/parse work is shared with backlinks/orphans/broken-links
        // calls. The graph already indexes raw links per source.
        const graph = await buildLinkGraph(vaultPath);

        // Resolve caller-provided path to its canonical form in the graph
        // (handles trailing-or-missing .md and basename-only inputs the way
        // get_backlinks does).
        const targetNormalized = notePath.replace(/\.md$/i, "").toLowerCase();
        const targetBasename = targetNormalized.split("/").pop() ?? targetNormalized;
        const resolvedSource =
          graph.sourceLookup.get(`exact:${targetNormalized}`) ??
          graph.sourceLookup.get(`base:${targetBasename}`) ??
          null;
        if (!resolvedSource) {
          return errorResult(`No note found matching path: ${displayLinkValue(notePath)}`);
        }

        const results = graph.outlinkDetails.get(resolvedSource) ?? [];

        if (results.length === 0) {
          const text = [
            "No outgoing links found in:",
            untrustedLinkBlock("get_outlinks source path", displayLinkValue(resolvedSource), "  "),
          ].join("\n");
          return textWithUntrustedMeta(text, "get_outlinks source path");
        }

        const valid = results.filter((r) => r.isValid);
        const broken = results.filter((r) => !r.isValid);

        const lines: string[] = [
          "Outgoing links from:",
          untrustedLinkBlock("get_outlinks source path", displayLinkValue(resolvedSource), "  "),
          `Total: ${results.length} (${valid.length} valid, ${broken.length} broken)\n`,
        ];

        if (valid.length > 0) {
          lines.push("Valid links:");
          for (const r of valid) {
            lines.push("  Resolved path:");
            lines.push(untrustedLinkBlock(
              "get_outlinks resolved path",
              `${displayLinkValue(r.resolvedPath ?? "")}${r.isEmbed ? " (embed)" : ""}`,
              "    ",
            ));
            pushUntrustedLinkTarget(lines, `outlink target: ${resolvedSource}`, r.target, "    ");
          }
        }

        if (broken.length > 0) {
          lines.push("\nBroken links:");
          for (const r of broken) {
            lines.push(`  - unresolved${r.isEmbed ? " (embed)" : ""}`);
            pushUntrustedLinkTarget(lines, `broken outlink target: ${resolvedSource}`, r.target, "    ");
          }
        }

        return textWithUntrustedMeta(lines.join("\n"), "get_outlinks paths and targets");
      } catch (err) {
        log.error("get_outlinks failed", { tool: "get_outlinks", err: err as Error });
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
          .max(1000)
          .optional()
          .default(200)
          .describe("Maximum total note paths to list across all categories (1-1000, default: 200). Full counts are always reported regardless."),
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

        let hasDisplayedPathRows = false;

        lines.push(`Fully isolated (no links in or out): ${fullyIsolated.length}`);
        hasDisplayedPathRows = pushUntrustedLinkPathRows(
          lines,
          "find_orphans fully isolated paths",
          cappedIsolated.map((note) => `- ${note.path}`),
          "  ",
        ) || hasDisplayedPathRows;
        if (cappedIsolated.length < fullyIsolated.length) {
          lines.push(`  ... and ${fullyIsolated.length - cappedIsolated.length} more`);
        }

        lines.push(`\nNo backlinks (not linked by any note): ${noBacklinks.length}`);
        hasDisplayedPathRows = pushUntrustedLinkPathRows(
          lines,
          "find_orphans no-backlink paths",
          cappedNoBacklinks.map((note) => `- ${note.path}`),
          "  ",
        ) || hasDisplayedPathRows;
        if (cappedNoBacklinks.length < noBacklinks.length) {
          lines.push(`  ... and ${noBacklinks.length - cappedNoBacklinks.length} more`);
        }

        if (includeOutlinksCheck) {
          lines.push(`\nNo outlinks (links to no other notes): ${noOutlinks.length}`);
          hasDisplayedPathRows = pushUntrustedLinkPathRows(
            lines,
            "find_orphans no-outlink paths",
            cappedNoOutlinks.map((note) => `- ${note.path}`),
            "  ",
          ) || hasDisplayedPathRows;
          if (cappedNoOutlinks.length < noOutlinks.length) {
            lines.push(`  ... and ${noOutlinks.length - cappedNoOutlinks.length} more`);
          }
        }

        const totalOrphans = fullyIsolated.length + noBacklinks.length + (includeOutlinksCheck ? noOutlinks.length : 0);
        lines.push(`\nTotal orphan entries: ${totalOrphans}`);

        return hasDisplayedPathRows
          ? textWithUntrustedMeta(lines.join("\n"), "find_orphans paths")
          : { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        log.error("find_orphans failed", { tool: "find_orphans", err: err as Error });
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
          .max(500)
          .optional()
          .describe("Restrict the scan to notes within this folder (resolution still uses the entire vault). Omit to scan every note."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(200)
          .describe("Maximum broken link entries to show (1-1000, default: 200). Grouped by source note. Remaining matches are summarized."),
      },
    },
    async ({ folder, maxResults }) => {
      try {
        // Validate and capture folder scope before the whole-vault graph work
        // so a missing folder fails fast. Resolution still uses the full graph.
        const scanNotes = folder ? await listNotes(vaultPath, folder) : null;
        const graph = await buildLinkGraph(vaultPath);
        const notesToScan = scanNotes ?? graph.allNotes;

        const brokenBySource = new Map<string, BrokenLink[]>();

        for (const notePath of notesToScan) {
          const brokenLinks = graph.brokenLinks.get(notePath);
          if (!brokenLinks || brokenLinks.length === 0) continue;
          brokenBySource.set(notePath, brokenLinks);
        }

        if (brokenBySource.size === 0) {
          const scopeStr = folder ? ` in folder: ${displayLinkValue(folder)}` : "";
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
        const scopeStr = folder ? ` (folder: ${displayLinkValue(folder)})` : "";
        lines.push(`Broken links report${scopeStr}\n`);

        let shown = 0;
        for (const [sourcePath, brokenLinks] of brokenBySource) {
          if (shown >= maxResults) break;
          lines.push("Source:");
          lines.push(untrustedLinkBlock("find_broken_links source path", displayLinkValue(sourcePath), "  "));
          for (const bl of brokenLinks) {
            if (shown >= maxResults) break;
            const lineStr = bl.line > 0 ? ` (line ${bl.line})` : "";
            lines.push(`  - broken link${lineStr}`);
            pushUntrustedLinkTarget(lines, `broken link target: ${sourcePath}:${bl.line}`, bl.targetLink, "    ");
            shown++;
          }
          lines.push("");
        }

        if (shown < totalBroken) {
          lines.push(`... and ${totalBroken - shown} more broken link(s) not shown`);
        }
        lines.push(`Total: ${totalBroken} broken link(s) across ${brokenBySource.size} file(s)`);

        return textWithUntrustedMeta(lines.join("\n"), "find_broken_links paths and targets");
      } catch (err) {
        log.error("find_broken_links failed", { tool: "find_broken_links", err: err as Error });
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
          .max(500)
          .describe("Starting note path relative to vault root (e.g., 'projects/alpha.md'). Extension optional; falls back to basename match."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .default(1)
          .describe("Maximum link-hops to traverse from the start note (1-3, default: 1). Higher values explore exponentially more notes."),
        direction: z
          .enum(["both", "inbound", "outbound"])
          .optional()
          .default("both")
          .describe("Traversal direction: 'outbound' follows outlinks the start note points to, 'inbound' follows backlinks pointing at the start note, 'both' follows either (default)"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(200)
          .describe("Maximum neighbor notes to return (1-1000, default: 200). Traversal stops early when this cap is reached and a truncation notice is appended."),
      },
    },
    async ({ path: startPath, depth, direction, maxResults }) => {
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
          return errorResult(`No note found matching path: ${displayLinkValue(startPath)}`);
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
          const text = [
            "No neighbors found for:",
            untrustedLinkBlock("get_graph_neighbors start path", displayLinkValue(resolvedStart), "  "),
            `(depth: ${depth}, direction: ${direction})`,
          ].join("\n");
          return textWithUntrustedMeta(text, "get_graph_neighbors start path");
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
        const lines: string[] = [
          "Graph neighbors of:",
          untrustedLinkBlock("get_graph_neighbors start path", displayLinkValue(resolvedStart), "  "),
          `Direction: ${direction} | Max depth: ${depth} | Found: ${visited.size} note(s)${truncatedStr}\n`,
          "Path tree:",
        ];
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
            pathTreeLines.push(`${indent}${arrow} ${displayLinkValue(neighbor.path)} (depth ${d})`);
          }
        }
        lines.push(untrustedLinkBlock("get_graph_neighbors path tree", pathTreeLines.join("\n")));

        if (truncated) {
          lines.push(`\nResults truncated at ${maxResults} neighbors. Reduce depth or narrow direction to see the full graph.`);
        }

        return textWithUntrustedMeta(lines.join("\n"), "get_graph_neighbors paths");
      } catch (err) {
        log.error("get_graph_neighbors failed", { tool: "get_graph_neighbors", err: err as Error });
        return errorResult(`Error getting graph neighbors: ${sanitizeError(err)}`);
      }
    },
  );
}
