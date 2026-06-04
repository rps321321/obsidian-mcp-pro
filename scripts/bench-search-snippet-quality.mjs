// Lexical search snippet-quality benchmark: run searchInContents over synthetic
// note bodies and measure repeated same-line snippet rows.
//
// Direct use: node scripts/bench-search-snippet-quality.mjs [--json]
// Run after `npm run build`.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vaultEntry = join(root, "build", "lib", "vault.js");
const QUERY = "migration";
const LIMIT = 5;

const notes = [
  {
    path: "migration-checklist.md",
    content: [
      "# Migration Checklist",
      "",
      "Migration prerequisites are ready.",
      "Rollback owners review the migration checklist.",
      "Post-deploy validation tracks migration health.",
    ].join("\n"),
  },
  {
    path: "migration-plan.md",
    content: [
      "# Migration Plan",
      "",
      "Migration scope is ready.",
      "Rollback owners handle the migration window.",
      "Validation tracks migration health.",
    ].join("\n"),
  },
  {
    path: "release-notes.md",
    content: [
      "# Release Notes",
      "",
      "The migration is one part of the release.",
    ].join("\n"),
  },
  {
    path: "zz-glossary.md",
    content: [
      "# Glossary",
      "",
      "Migration: a generic vocabulary entry.",
    ].join("\n"),
  },
  {
    path: "meeting-transcript.md",
    content: [
      "# Meeting Transcript",
      "",
      "Migration came up during unrelated staffing notes.",
      "Migration migration migration migration migration migration migration.",
    ].join("\n"),
  },
];

function summarizeHit(hit) {
  const lineKeys = new Set(hit.matches.map((match) => match.line));
  const duplicateLineRows = hit.matches.length - lineKeys.size;
  return {
    notePath: hit.relativePath,
    matchCount: hit.matches.length,
    uniqueLineCount: lineKeys.size,
    duplicateLineRows,
  };
}

export async function runSearchSnippetQualityBench() {
  const { searchInContents } = await import(pathToFileURL(vaultEntry).href);
  const notePaths = notes.map((note) => note.path);
  const contents = new Map(notes.map((note) => [note.path, note.content]));
  const hits = searchInContents(notePaths, contents, QUERY, { maxResults: LIMIT });
  const rows = hits.map(summarizeHit);
  const totalSnippetRows = rows.reduce((sum, row) => sum + row.matchCount, 0);
  const uniqueSnippetLines = rows.reduce((sum, row) => sum + row.uniqueLineCount, 0);
  const duplicateSnippetRows = rows.reduce((sum, row) => sum + row.duplicateLineRows, 0);

  return {
    query: QUERY,
    limit: LIMIT,
    totalSnippetRows,
    uniqueSnippetLines,
    duplicateSnippetRows,
    uniqueLineCoverage: totalSnippetRows === 0 ? 1 : uniqueSnippetLines / totalSnippetRows,
    rows,
  };
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(vaultEntry)) {
    console.error("build/lib/vault.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const result = await runSearchSnippetQualityBench();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`duplicate snippet rows ${result.duplicateSnippetRows}`);
    console.log(`unique line coverage ${result.uniqueLineCoverage.toFixed(3)}`);
    console.log(`total snippet rows ${result.totalSnippetRows}`);
    console.log(`unique snippet lines ${result.uniqueSnippetLines}`);
    console.log("\n| note | matches | unique lines | duplicate rows |");
    console.log("|---|---:|---:|---:|");
    for (const row of result.rows) {
      console.log(`| ${row.notePath} | ${row.matchCount} | ${row.uniqueLineCount} | ${row.duplicateLineRows} |`);
    }
  }
}
