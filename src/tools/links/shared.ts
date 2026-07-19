import type { RichTextBuilder } from "../../lib/tool-seam.js";
import { escapeControlChars } from "../../lib/errors.js";
import path from "path";
import {
  getNoteStats,
  getVaultRootRealPath,
  listNotes,
} from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import {
  extractWikilinks,
  extractAliases,
  normalizeWikilinkTargetPath,
} from "../../lib/markdown.js";
import { log } from "../../lib/logger.js";
import type { LinkInfo, BrokenLink } from "../../types.js";

export interface LinkGraphData {
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

export interface NotePathIndex {
  exact: Map<string, string>;
  basename: Map<string, string[]>;
}

export interface OutlinkDetail {
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
export const REDACTED_ALIAS_LABEL = "<vault alias>";

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
  mtimes: ReadonlyMap<string, number>
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
  notes: string[]
): Promise<string> {
  const mtimes = new Map<string, number>();
  const sorted = [...notes].sort();
  const realVaultRoot = await getVaultRootRealPath(vaultPath);
  for (let i = 0; i < sorted.length; i += GRAPH_FINGERPRINT_CONCURRENCY) {
    const slice = sorted.slice(i, i + GRAPH_FINGERPRINT_CONCURRENCY);
    const stats = await Promise.all(
      slice.map((n) =>
        getNoteStats(vaultPath, n, { realVaultRoot }).catch(() => null)
      )
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

function normalizeGraphInputPath(input: string): string {
  const slashed = input.replace(/\\/g, "/");
  const withoutExt = slashed.replace(/\.md$/i, "");
  const normalized = path.posix.normalize(withoutExt);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return withoutExt.toLowerCase();
  }
  return normalized.replace(/\/+$/g, "").toLowerCase();
}

export function resolveGraphInputPath(
  graph: LinkGraphData,
  input: string
): string | null {
  const normalized = normalizeGraphInputPath(input);
  const basename = normalized.split("/").pop() ?? normalized;
  return (
    graph.sourceLookup.get(`exact:${normalized}`) ??
    graph.sourceLookup.get(`base:${basename}`) ??
    null
  );
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
  aliasMap: Map<string, string>
): string | null {
  const cleanLink = link.split("#")[0]!.split("^")[0]!.trim();
  if (!cleanLink) return null;

  const normalizedLink = normalizeWikilinkTargetPath(cleanLink);
  const normalizedLinkLower = normalizedLink.toLowerCase();

  const exact = index.exact.get(normalizedLinkLower);
  if (exact) return exact;

  if (normalizedLink.includes("/")) {
    const suffixCandidates: string[] = [];
    for (const notePath of allNotePaths) {
      const withoutExt = notePath.replace(/\.md$/i, "").toLowerCase();
      if (withoutExt.endsWith(normalizedLinkLower)) {
        const prefix = withoutExt.slice(
          0,
          withoutExt.length - normalizedLinkLower.length
        );
        if (prefix === "" || prefix.endsWith("/"))
          suffixCandidates.push(notePath);
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

function nearestNotePath(
  currentNotePath: string,
  candidates: readonly string[]
): string {
  const sourceDir = path.dirname(currentNotePath).replace(/\\/g, "/");
  return [...candidates].sort((a, b) => {
    const da = sharedPathDepth(sourceDir, path.dirname(a).replace(/\\/g, "/"));
    const db = sharedPathDepth(sourceDir, path.dirname(b).replace(/\\/g, "/"));
    if (da !== db) return db - da;
    return a.length - b.length;
  })[0]!;
}

export async function buildLinkGraph(
  vaultPath: string,
  folder?: string
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
    }
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
        log.warn("Duplicate alias", {
          alias: REDACTED_ALIAS_LABEL,
          notes: [prior, notePath],
        });
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

      const resolved = resolveWikilinkWithIndex(
        targetBase,
        notePath,
        allNotes,
        pathIndex,
        aliasMap
      );
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

export function findLineWithLink(
  lines: string[],
  linkTarget: string
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
      if (
        afterPos <= lineLower.length &&
        exactSuffixes.some((s) => lineLower.startsWith(s, afterPos))
      ) {
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
      if (
        afterPos <= lineLower.length &&
        exactSuffixes.some((s) => lineLower.startsWith(s, afterPos))
      ) {
        return { line: i + 1, content: line.trim() };
      }
    }
  }
  return { line: 0, content: "" };
}

export function displayLinkValue(value: string): string {
  return escapeControlChars(value);
}

// Group render helpers that emit through the seam's richText builder — the seam
// owns the actual BEGIN/END wrapping and the block-level trust `_meta`. These
// factor the "Target:" and path-rows shapes shared across the link tools.

/** Append a "Target:" label line plus the target as a wrapped untrusted block. */
export function untrustedLinkTarget(
  b: RichTextBuilder,
  label: string,
  target: string,
  indent: string
): void {
  b.trusted(`${indent}Target:`);
  b.untrusted(label, displayLinkValue(target), `${indent}  `);
}

/** Append `rows` as one wrapped untrusted block, or nothing when empty. Emitting
 *  no untrusted section is what keeps richText from attaching the block-level
 *  `_meta`, so an all-empty result stays untagged. */
export function untrustedLinkPathRows(
  b: RichTextBuilder,
  label: string,
  rows: readonly string[],
  indent = ""
): void {
  if (rows.length === 0) return;
  b.untrusted(label, rows.map(displayLinkValue).join("\n"), indent);
}

export { resolveWikilinkWithIndex };
