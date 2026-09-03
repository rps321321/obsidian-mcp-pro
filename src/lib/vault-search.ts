import { listNotes, readAllCached } from "./vault-reads.js";
import type { SearchResult, SearchMatch } from "../types.js";

const SEARCH_PATH_MATCH_BOOST = 4;
const SEARCH_HEADING_MATCH_BOOST = 4;
const SEARCH_MATCH_COUNT_WEIGHT = 0.25;
const SEARCH_REPEATED_SAME_LINE_PENALTY = 0.5;
const SEARCH_SNIPPET_MAX_CHARS = 240;
const SEARCH_SNIPPET_OMISSION = "...";

/**
 * Pure scanner: search a pre-loaded set of note contents for `query`.
 * `searchNotes` owns the vault-wide I/O path and loads those contents through
 * the canonical cached batch-read seam.
 */
export function searchInContents(
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  query: string,
  options?: { caseSensitive?: boolean; maxResults?: number }
): SearchResult[] {
  const caseSensitive = options?.caseSensitive ?? false;
  const maxResults = options?.maxResults ?? 100;
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  if (searchQuery.length === 0) return [];

  const results: SearchResult[] = [];
  for (const notePath of notes) {
    const content = contents.get(notePath);
    if (content === undefined) continue;

    const lines = content.split("\n");
    const rawMatches: SearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const compareLine = caseSensitive ? line : line.toLowerCase();
      let startIndex = 0;
      while (true) {
        const col = compareLine.indexOf(searchQuery, startIndex);
        if (col === -1) break;
        rawMatches.push({
          line: i + 1,
          content: formatSearchSnippet(line, col, searchQuery.length),
          column: col,
        });
        startIndex = col + searchQuery.length;
      }
    }
    if (rawMatches.length === 0) continue;
    results.push({
      path: notePath,
      relativePath: notePath,
      matches: collapseSearchLineMatches(rawMatches),
      score: scoreLexicalMatches(
        notePath,
        lines,
        rawMatches,
        searchQuery,
        caseSensitive
      ),
    });
  }
  // Primary: lexical focus score (desc). Secondary: relative path (asc) — otherwise
  // tie-breaking order depends on iteration timing, which makes results for
  // equal-score queries non-deterministic between runs.
  results.sort(
    (a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath)
  );
  return results.slice(0, maxResults);
}

function collapseSearchLineMatches(
  matches: readonly SearchMatch[]
): SearchMatch[] {
  const seenLines = new Set<number>();
  return matches.filter((match) => {
    if (seenLines.has(match.line)) return false;
    seenLines.add(match.line);
    return true;
  });
}

function formatSearchSnippet(
  line: string,
  column: number,
  queryLength: number
): string {
  const trimmedStart = line.trimStart();
  const leadingTrimmedChars = line.length - trimmedStart.length;
  const trimmedLine = trimmedStart.trimEnd();
  const maxSnippetChars = Math.max(
    SEARCH_SNIPPET_MAX_CHARS,
    queryLength + SEARCH_SNIPPET_OMISSION.length * 2
  );

  if (trimmedLine.length <= maxSnippetChars) return trimmedLine;

  const snippetColumn = Math.max(0, column - leadingTrimmedChars);
  const queryStart = Math.min(snippetColumn, trimmedLine.length);
  const bodyMaxChars = maxSnippetChars - SEARCH_SNIPPET_OMISSION.length * 2;
  let start = Math.max(
    0,
    queryStart - Math.floor((bodyMaxChars - queryLength) / 2)
  );
  const end = Math.min(trimmedLine.length, start + bodyMaxChars);
  if (end === trimmedLine.length) start = Math.max(0, end - bodyMaxChars);

  const prefix = start > 0 ? SEARCH_SNIPPET_OMISSION : "";
  const suffix = end < trimmedLine.length ? SEARCH_SNIPPET_OMISSION : "";
  return `${prefix}${trimmedLine.slice(start, end)}${suffix}`;
}

function scoreLexicalMatches(
  notePath: string,
  lines: readonly string[],
  matches: readonly SearchMatch[],
  searchQuery: string,
  caseSensitive: boolean
): number {
  const matchingLines = new Set(matches.map((match) => match.line)).size;
  const repeatedSameLineMatches = matches.length - matchingLines;
  const pathText = caseSensitive ? notePath : notePath.toLowerCase();
  const firstHeading =
    lines.find((line) => line.trimStart().startsWith("#")) ?? "";
  const headingText = caseSensitive ? firstHeading : firstHeading.toLowerCase();

  let score =
    matchingLines + Math.log1p(matches.length) * SEARCH_MATCH_COUNT_WEIGHT;
  if (pathText.includes(searchQuery)) score += SEARCH_PATH_MATCH_BOOST;
  if (headingText.includes(searchQuery)) score += SEARCH_HEADING_MATCH_BOOST;
  score -= repeatedSameLineMatches * SEARCH_REPEATED_SAME_LINE_PENALTY;
  return Math.max(0, score);
}

export async function searchNotes(
  vaultPath: string,
  query: string,
  options?: {
    caseSensitive?: boolean;
    maxResults?: number;
    folder?: string;
  }
): Promise<SearchResult[]> {
  const notes = await listNotes(vaultPath, options?.folder);

  // Vault-wide search is a batch semantic: reuse unchanged note bodies across
  // repeated scans while keeping point reads (`readNote`) direct and fresh.
  // Per-file failures are intentionally omitted without logging note paths so
  // one unreadable note does not abort the search or leak vault layout.
  const { contents } = await readAllCached(vaultPath, notes);

  return searchInContents(notes, contents, query, options);
}
