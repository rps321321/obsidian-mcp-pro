// Graph-neighbors benchmark: generate throwaway vaults and time
// get_graph_neighbors through a real stdio MCP client.
//
// Direct use: node scripts/bench-graph-neighbors.mjs [sizes] [--json]
//   e.g. node scripts/bench-graph-neighbors.mjs 100,1000
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
  return `neighbor-note-${String(i).padStart(6, "0")}`;
}

export function makeGraphNeighborsVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-neighbors-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const folder = i % 8 === 0 ? join(dir, "reference") : join(dir, `areas/team-${i % 24}`);
    mkdirSync(folder, { recursive: true });

    const next = noteName((i + 1) % n);
    const skip = noteName((i + 7) % n);
    const prevAlias = `Alias ${String((i + n - 3) % n).padStart(6, "0")}`;
    const hub = noteName(i % Math.min(n, 40));
    const broken = i % 43 === 0 ? ` [[missing-neighbor-${i}]]` : "";

    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [
        "---",
        "aliases:",
        `  - Alias ${String(i).padStart(6, "0")}`,
        "---",
        "",
        `# ${noteName(i)}`,
        "",
        `Links: [[${next}]] [[${skip}]] [[${prevAlias}]] [[${hub}]]${broken}`,
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

async function timeGraphNeighbors(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "graph-neighbors-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldNeighborsMs = await timeCall(client, "get_graph_neighbors", {
      path: `${noteName(0)}.md`,
      depth: 2,
      direction: "both",
      maxResults: 300,
    });
    const warmNeighborsMs = await timeCall(client, "get_graph_neighbors", {
      path: `${noteName(17)}.md`,
      depth: 2,
      direction: "both",
      maxResults: 300,
    });
    const warmOutboundMs = await timeCall(client, "get_graph_neighbors", {
      path: `${noteName(31)}.md`,
      depth: 3,
      direction: "outbound",
      maxResults: 300,
    });
    return { coldNeighborsMs, warmNeighborsMs, warmOutboundMs };
  } finally {
    await client.close();
  }
}

export async function runGraphNeighborsBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeGraphNeighborsVault(n);
    try {
      const timings = await timeGraphNeighbors(vault);
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
  const rows = await runGraphNeighborsBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold graph neighbors ${r.coldNeighborsMs.toFixed(0)}ms`,
          `warm graph neighbors ${r.warmNeighborsMs.toFixed(0)}ms`,
          `warm outbound neighbors ${r.warmOutboundMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold graph neighbors | warm graph neighbors | warm outbound neighbors |");
    console.log("|------:|---------------------:|---------------------:|------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldNeighborsMs.toFixed(0)}ms | ${r.warmNeighborsMs.toFixed(0)}ms | ${r.warmOutboundMs.toFixed(0)}ms |`,
      );
    }
  }
}
