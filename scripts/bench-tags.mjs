// Tag benchmark: generate throwaway tagged vaults and time tag tools through a
// real stdio MCP client.
//
// Direct use: node scripts/bench-tags.mjs [sizes] [--json]
//   e.g. node scripts/bench-tags.mjs 100,1000
// Run after `npm run build`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");
const sparseTag = "special/target";

function noteName(i) {
  return `note-${String(i).padStart(6, "0")}`;
}

export function makeTagVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-tag-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));
  for (let i = 0; i < n; i++) {
    const folder = i % 10 === 0 ? join(dir, `area-${i % 50}`) : dir;
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    const name = noteName(i);
    const topic = `topic/${String(i % 25).padStart(2, "0")}`;
    const owner = `team/${i % 12}`;
    const state = i % 3 === 0 ? "archive" : "active";
    const sparse = i % 257 === 0 ? ` #${sparseTag}` : "";
    writeFileSync(
      join(folder, `${name}.md`),
      [
        "---",
        "tags:",
        "  - bench",
        `  - ${topic}`,
        `  - ${owner}`,
        "---",
        "",
        `# ${name}`,
        "",
        `#bench #${topic} #state/${state}${sparse}`,
        "",
        `Related tags: ${owner}, ${topic}.`,
        "",
      ].join("\n"),
    );
  }
  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeTags(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "tag-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldListTagsMs = await timeCall(client, "list_tags", { sortBy: "count" });
    const warmListTagsMs = await timeCall(client, "list_tags", { sortBy: "count" });
    const warmSearchByTagMs = await timeCall(client, "search_by_tag", {
      tag: sparseTag,
      includeContent: false,
      maxResults: 100,
    });
    return { coldListTagsMs, warmListTagsMs, warmSearchByTagMs };
  } finally {
    await client.close();
  }
}

export async function runTagBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeTagVault(n);
    try {
      const timings = await timeTags(vault);
      rows.push({ n, ...timings });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  }
  return rows;
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(entry)) {
    console.error("build/index.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const sizesArg = args.find((a) => !a.startsWith("--"));
  const sizes = (sizesArg ?? "100,1000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rows = await runTagBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold list_tags ${r.coldListTagsMs.toFixed(0)}ms`,
          `warm list_tags ${r.warmListTagsMs.toFixed(0)}ms`,
          `warm search_by_tag ${r.warmSearchByTagMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold list_tags | warm list_tags | warm search_by_tag |");
    console.log("|------:|---------------:|---------------:|-------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldListTagsMs.toFixed(0)}ms | ${r.warmListTagsMs.toFixed(0)}ms | ${r.warmSearchByTagMs.toFixed(0)}ms |`,
      );
    }
  }
}
