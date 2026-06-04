// Vault-stats benchmark: generate throwaway note-heavy vaults and time
// get_vault_stats through a real stdio MCP client.
//
// Direct use: node scripts/bench-vault-stats.mjs [sizes] [--json]
//   e.g. node scripts/bench-vault-stats.mjs 100,1000
// Run after `npm run build`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");

function noteName(i) {
  return `note-${String(i).padStart(6, "0")}`;
}

export function makeVaultStatsVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-vault-stats-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));
  const now = Date.now();

  for (let i = 0; i < n; i++) {
    const folder = i % 6 === 0 ? join(dir, `projects/area-${i % 30}`) : join(dir, "journal");
    mkdirSync(folder, { recursive: true });
    const topic = `topic/${String(i % 25).padStart(2, "0")}`;
    const owner = `team/${i % 10}`;
    const taggedLine = i % 13 === 0 ? "" : `#stats/bench #${topic}`;
    const fullPath = join(folder, `${noteName(i)}.md`);
    writeFileSync(
      fullPath,
      [
        "---",
        "tags:",
        `  - ${owner}`,
        i % 13 === 0 ? "" : `  - ${topic}`,
        "---",
        "",
        `# ${noteName(i)}`,
        "",
        `Synthetic vault stat note ${i} with enough body text for word totals.`,
        "A second sentence keeps byte and word aggregation realistic.",
        taggedLine,
        "",
      ].join("\n"),
    );
    const when = new Date(now - (n - i) * 60 * 60 * 1000);
    utimesSync(fullPath, when, when);
  }

  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeVaultStats(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "vault-stats-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldVaultStatsMs = await timeCall(client, "get_vault_stats", {});
    const warmVaultStatsMs = await timeCall(client, "get_vault_stats", {});
    const warmFolderVaultStatsMs = await timeCall(client, "get_vault_stats", {
      folder: "projects",
    });
    return { coldVaultStatsMs, warmVaultStatsMs, warmFolderVaultStatsMs };
  } finally {
    await client.close();
  }
}

export async function runVaultStatsBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeVaultStatsVault(n);
    try {
      const timings = await timeVaultStats(vault);
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
  const rows = await runVaultStatsBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold get_vault_stats ${r.coldVaultStatsMs.toFixed(0)}ms`,
          `warm get_vault_stats ${r.warmVaultStatsMs.toFixed(0)}ms`,
          `warm get_vault_stats folder=projects ${r.warmFolderVaultStatsMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold get_vault_stats | warm get_vault_stats | warm get_vault_stats folder=projects |");
    console.log("|------:|---------------------:|---------------------:|-------------------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldVaultStatsMs.toFixed(0)}ms | ${r.warmVaultStatsMs.toFixed(0)}ms | ${r.warmFolderVaultStatsMs.toFixed(0)}ms |`,
      );
    }
  }
}
