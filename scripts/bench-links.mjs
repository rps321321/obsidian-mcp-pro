// Link graph benchmark: generate throwaway vaults and time graph-backed link
// tools through a real stdio MCP client.
//
// Direct use: node scripts/bench-links.mjs [sizes] [--json]
//   e.g. node scripts/bench-links.mjs 100,1000
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

function noteName(i) {
  return `note-${String(i).padStart(6, "0")}`;
}

export function makeLinkVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-link-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));
  for (let i = 0; i < n; i++) {
    const name = noteName(i);
    const next = noteName((i + 1) % n);
    const prev = noteName((i + n - 1) % n);
    const hubAlias = `Alias ${String(i % Math.min(n, 25)).padStart(6, "0")}`;
    const broken = i % 37 === 0 ? `\nBroken: [[missing-target-${i}]]` : "";
    writeFileSync(
      join(dir, `${name}.md`),
      [
        "---",
        "aliases:",
        `  - Alias ${String(i).padStart(6, "0")}`,
        "---",
        "",
        `# ${name}`,
        "",
        `Links: [[${next}]] [[${prev}]] [[${hubAlias}]]`,
        broken,
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

async function timeLinkGraph(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "link-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldNeighborsMs = await timeCall(client, "get_graph_neighbors", {
      path: "note-000000.md",
      depth: 2,
      direction: "both",
      maxResults: 200,
    });
    const warmBacklinksMs = await timeCall(client, "get_backlinks", {
      path: "note-000001.md",
    });
    const warmNeighborsMs = await timeCall(client, "get_graph_neighbors", {
      path: "note-000010.md",
      depth: 2,
      direction: "both",
      maxResults: 200,
    });
    return { coldNeighborsMs, warmBacklinksMs, warmNeighborsMs };
  } finally {
    await client.close();
  }
}

export async function runLinkBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeLinkVault(n);
    try {
      const timings = await timeLinkGraph(vault);
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
  const rows = await runLinkBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold graph ${r.coldNeighborsMs.toFixed(0)}ms`,
          `warm backlinks ${r.warmBacklinksMs.toFixed(0)}ms`,
          `warm graph ${r.warmNeighborsMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold graph neighbors | warm backlinks | warm graph neighbors |");
    console.log("|------:|---------------------:|---------------:|---------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldNeighborsMs.toFixed(0)}ms | ${r.warmBacklinksMs.toFixed(0)}ms | ${r.warmNeighborsMs.toFixed(0)}ms |`,
      );
    }
  }
}
