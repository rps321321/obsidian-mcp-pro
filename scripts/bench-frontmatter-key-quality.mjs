// Frontmatter key-quality benchmark: measure whether search_by_frontmatter
// misses notes when the YAML key casing differs from the requested property.
//
// Direct use: node scripts/bench-frontmatter-key-quality.mjs [--json]
// Run after `npm run build`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");
const QUERY_PROPERTY = "status";
const QUERY_VALUE = "ready";

const notes = [
  {
    path: "lower-status.md",
    relevant: true,
    content: "---\nstatus: ready\n---\n# Lower Status\n",
  },
  {
    path: "title-status.md",
    relevant: true,
    content: "---\nStatus: ready\n---\n# Title Status\n",
  },
  {
    path: "upper-status.md",
    relevant: true,
    content: "---\nSTATUS: ready\n---\n# Upper Status\n",
  },
  {
    path: "blocked-status.md",
    relevant: false,
    content: "---\nstatus: blocked\n---\n# Blocked Status\n",
  },
  {
    path: "owner-ready.md",
    relevant: false,
    content: "---\nowner: ready\n---\n# Owner Ready\n",
  },
];

const expectedRelevantPaths = notes.filter((note) => note.relevant).map((note) => note.path);

export function makeFrontmatterKeyQualityVault() {
  const dir = mkdtempSync(join(tmpdir(), "ompro-frontmatter-key-quality-"));
  mkdirSync(join(dir, ".obsidian"));
  for (const note of notes) {
    writeFileSync(join(dir, note.path), note.content, "utf-8");
  }
  return dir;
}

function textFromResult(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function extractResultPaths(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

async function searchFrontmatter(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "frontmatter-key-quality-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "search_by_frontmatter",
      arguments: {
        property: QUERY_PROPERTY,
        value: QUERY_VALUE,
        maxResults: 10,
      },
    });
    return extractResultPaths(textFromResult(result));
  } finally {
    await client.close();
  }
}

export async function runFrontmatterKeyQualityBench() {
  const vault = makeFrontmatterKeyQualityVault();
  try {
    const matchedPaths = await searchFrontmatter(vault);
    const matchedSet = new Set(matchedPaths);
    const relevantMatchedPaths = expectedRelevantPaths.filter((path) => matchedSet.has(path));
    const missedVariantPaths = expectedRelevantPaths.filter((path) => !matchedSet.has(path));
    const falsePositivePaths = matchedPaths.filter((path) => !expectedRelevantPaths.includes(path));
    const duplicatePathCount = matchedPaths.length - new Set(matchedPaths).size;

    return {
      query: { property: QUERY_PROPERTY, value: QUERY_VALUE },
      expectedRelevant: expectedRelevantPaths.length,
      matchedRelevant: relevantMatchedPaths.length,
      caseVariantRecall: relevantMatchedPaths.length / expectedRelevantPaths.length,
      exactKeyMatches: matchedSet.has("lower-status.md") ? 1 : 0,
      caseVariantMatches: relevantMatchedPaths.filter((path) => path !== "lower-status.md").length,
      caseVariantMisses: missedVariantPaths.length,
      wrongKeyMatches: falsePositivePaths.length,
      duplicatePathCount,
      matchedPaths,
      missedVariantPaths,
      falsePositivePaths,
    };
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(entry)) {
    console.error("build/index.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const result = await runFrontmatterKeyQualityBench();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`case-variant recall ${result.caseVariantRecall.toFixed(3)}`);
    console.log(`matched relevant ${result.matchedRelevant}/${result.expectedRelevant}`);
    console.log(`case-variant misses ${result.caseVariantMisses}`);
    console.log(`wrong-key matches ${result.wrongKeyMatches}`);
    console.log(`duplicate paths ${result.duplicatePathCount}`);
    console.log("\n| result | paths |");
    console.log("|---|---|");
    console.log(`| matched | ${result.matchedPaths.join(", ") || "-"} |`);
    console.log(`| missed variants | ${result.missedVariantPaths.join(", ") || "-"} |`);
    console.log(`| wrong-key matches | ${result.falsePositivePaths.join(", ") || "-"} |`);
  }
}
