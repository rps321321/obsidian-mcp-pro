// Lexical search snippet-length benchmark: run searchInContents over synthetic
// note bodies and measure whether a single matching line can dominate output.
//
// Direct use: node scripts/bench-search-snippet-length.mjs [--json]
// Run after `npm run build`.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vaultEntry = join(root, "build", "lib", "vault.js");
const QUERY = "migration";
const LIMIT = 5;
const MAX_SNIPPET_CHARS_BAR = 240;
const MAX_TOTAL_SNIPPET_CHARS_BAR = 640;

const longTail = Array.from({ length: 180 }, (_, index) => `context-${index + 1}`).join(" ");

const notes = [
  {
    path: "migration-status.md",
    content: [
      "# Migration Status",
      "",
      `Migration status: ${longTail}. Owner, rollback, and validation notes are buried after a long copied status line.`,
    ].join("\n"),
  },
  {
    path: "migration-plan.md",
    content: [
      "# Migration Plan",
      "",
      "Migration owner and rollback scope are ready.",
      "Validation follows the release checklist.",
    ].join("\n"),
  },
  {
    path: "release-notes.md",
    content: [
      "# Release Notes",
      "",
      "The migration is mentioned as one part of the release.",
    ].join("\n"),
  },
];

function summarizeHit(hit) {
  const snippetChars = hit.matches.reduce((sum, match) => sum + match.content.length, 0);
  const maxSnippetChars = hit.matches.reduce((max, match) => Math.max(max, match.content.length), 0);
  const queryPresentRows = hit.matches.filter((match) => match.content.toLowerCase().includes(QUERY)).length;
  return {
    notePath: hit.relativePath,
    snippetRows: hit.matches.length,
    snippetChars,
    maxSnippetChars,
    oversizedSnippetRows: hit.matches.filter((match) => match.content.length > MAX_SNIPPET_CHARS_BAR).length,
    queryPresentRows,
  };
}

export async function runSearchSnippetLengthBench() {
  const { searchInContents } = await import(pathToFileURL(vaultEntry).href);
  const notePaths = notes.map((note) => note.path);
  const contents = new Map(notes.map((note) => [note.path, note.content]));
  const hits = searchInContents(notePaths, contents, QUERY, { maxResults: LIMIT });
  const rows = hits.map(summarizeHit);
  const totalSnippetChars = rows.reduce((sum, row) => sum + row.snippetChars, 0);
  const maxSnippetChars = rows.reduce((max, row) => Math.max(max, row.maxSnippetChars), 0);
  const oversizedSnippetRows = rows.reduce((sum, row) => sum + row.oversizedSnippetRows, 0);
  const snippetsKeepQuery = rows.every((row) => row.queryPresentRows === row.snippetRows);

  return {
    query: QUERY,
    limit: LIMIT,
    totalSnippetChars,
    maxSnippetChars,
    oversizedSnippetRows,
    snippetsKeepQuery,
    clearsLengthBars:
      maxSnippetChars <= MAX_SNIPPET_CHARS_BAR &&
      totalSnippetChars <= MAX_TOTAL_SNIPPET_CHARS_BAR &&
      oversizedSnippetRows === 0 &&
      snippetsKeepQuery,
    rows,
  };
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(vaultEntry)) {
    console.error("build/lib/vault.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const result = await runSearchSnippetLengthBench();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`max snippet chars ${result.maxSnippetChars}`);
    console.log(`total snippet chars ${result.totalSnippetChars}`);
    console.log(`oversized snippet rows ${result.oversizedSnippetRows}`);
    console.log(`snippets keep query ${result.snippetsKeepQuery}`);
    console.log(`clears length bars ${result.clearsLengthBars}`);
    console.log("\n| note | rows | snippet chars | max snippet chars | oversized rows |");
    console.log("|---|---:|---:|---:|---:|");
    for (const row of result.rows) {
      console.log(`| ${row.notePath} | ${row.snippetRows} | ${row.snippetChars} | ${row.maxSnippetChars} | ${row.oversizedSnippetRows} |`);
    }
  }
}
