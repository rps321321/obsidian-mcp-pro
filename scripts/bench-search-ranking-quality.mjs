// Lexical search ranking benchmark: run searchInContents over synthetic note
// bodies and score whether focused notes outrank noisy repeated mentions.
//
// Direct use: node scripts/bench-search-ranking-quality.mjs [--json]
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
    path: "meeting-transcript.md",
    relevance: 1,
    content: [
      "# Meeting Transcript",
      "",
      "Migration came up repeatedly while the group was discussing unrelated staffing updates.",
      "Migration migration migration migration migration migration migration.",
    ].join("\n"),
  },
  {
    path: "migration-plan.md",
    relevance: 3,
    content: [
      "# Migration Plan",
      "",
      "Migration scope, migration rollback, and migration owner decisions for the database cutover.",
    ].join("\n"),
  },
  {
    path: "migration-checklist.md",
    relevance: 3,
    content: [
      "# Migration Checklist",
      "",
      "Migration prerequisites and migration verification steps for the production cutover.",
    ].join("\n"),
  },
  {
    path: "release-notes.md",
    relevance: 2,
    content: [
      "# Release Notes",
      "",
      "The migration is mentioned as one part of the release, with links to the plan.",
    ].join("\n"),
  },
  {
    path: "zz-glossary.md",
    relevance: 0,
    content: [
      "# Glossary",
      "",
      "Migration: a term that appears in a generic vocabulary list.",
    ].join("\n"),
  },
  {
    path: "cooking.md",
    relevance: 0,
    content: [
      "# Cooking",
      "",
      "Pantry planning and recipe notes.",
    ].join("\n"),
  },
];

function gain(relevance) {
  return (2 ** relevance) - 1;
}

function dcg(relevances) {
  return relevances.reduce((sum, relevance, index) => {
    return sum + gain(relevance) / Math.log2(index + 2);
  }, 0);
}

function ndcgAt(results, k) {
  const actual = results.slice(0, k).map((row) => row.relevance);
  const ideal = [...notes]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k)
    .map((row) => row.relevance);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg;
}

function hasIncidentalBeforeFocused(results) {
  const firstFocused = results.findIndex((row) => row.relevance === 3);
  const firstIncidental = results.findIndex((row) => row.relevance === 1);
  return firstIncidental !== -1 && firstFocused !== -1 && firstIncidental < firstFocused;
}

export async function runSearchRankingQualityBench() {
  const { searchInContents } = await import(pathToFileURL(vaultEntry).href);
  const notePaths = notes.map((note) => note.path);
  const contents = new Map(notes.map((note) => [note.path, note.content]));
  const hits = searchInContents(notePaths, contents, QUERY, { maxResults: LIMIT });
  const relevanceByPath = new Map(notes.map((note) => [note.path, note.relevance]));
  const rows = hits.map((hit, index) => ({
    rank: index + 1,
    notePath: hit.relativePath,
    score: hit.score,
    matchCount: hit.matches.length,
    firstLine: hit.matches[0]?.line ?? null,
    relevance: relevanceByPath.get(hit.relativePath) ?? 0,
  }));
  const topK = rows.slice(0, 3);

  return {
    query: QUERY,
    limit: LIMIT,
    ndcgAt3: ndcgAt(rows, 3),
    precisionAt3: topK.filter((row) => row.relevance >= 2).length / 3,
    topRelevance: rows[0]?.relevance ?? 0,
    incidentalBeforeFocused: hasIncidentalBeforeFocused(rows),
    rows,
  };
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(vaultEntry)) {
    console.error("build/lib/vault.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const result = await runSearchRankingQualityBench();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`NDCG@3 ${result.ndcgAt3.toFixed(3)}`);
    console.log(`precision@3 ${result.precisionAt3.toFixed(3)}`);
    console.log(`top relevance ${result.topRelevance}`);
    console.log(`incidental before focused ${result.incidentalBeforeFocused}`);
    console.log("\n| rank | note | rel | snippet lines | score |");
    console.log("|---:|---|---:|---:|---:|");
    for (const row of result.rows) {
      console.log(`| ${row.rank} | ${row.notePath} | ${row.relevance} | ${row.matchCount} | ${row.score.toFixed(3)} |`);
    }
  }
}
