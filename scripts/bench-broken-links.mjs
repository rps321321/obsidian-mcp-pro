// Broken-link benchmark: generate throwaway link-heavy vaults and time two
// find_broken_links calls through a real stdio MCP client.
//
// Direct use: node scripts/bench-broken-links.mjs [sizes] [--json]
//   e.g. node scripts/bench-broken-links.mjs 100,1000
// Run after `npm run build`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { makeLinkVault } from "./bench-links.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeBrokenLinks(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "broken-link-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldBrokenMs = await timeCall(client, "find_broken_links", {
      maxResults: 100,
    });
    const warmBrokenMs = await timeCall(client, "find_broken_links", {
      maxResults: 100,
    });
    return { coldBrokenMs, warmBrokenMs };
  } finally {
    await client.close();
  }
}

export async function runBrokenLinkBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeLinkVault(n);
    try {
      const timings = await timeBrokenLinks(vault);
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
  const rows = await runBrokenLinkBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold broken links ${r.coldBrokenMs.toFixed(0)}ms`,
          `warm broken links ${r.warmBrokenMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold broken links | warm broken links |");
    console.log("|------:|------------------:|------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldBrokenMs.toFixed(0)}ms | ${r.warmBrokenMs.toFixed(0)}ms |`,
      );
    }
  }
}
