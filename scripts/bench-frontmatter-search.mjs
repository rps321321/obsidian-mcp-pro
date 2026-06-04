// Frontmatter-search benchmark: generate throwaway metadata-heavy vaults and
// time search_by_frontmatter through a real stdio MCP client.
//
// Direct use: node scripts/bench-frontmatter-search.mjs [sizes] [--json]
//   e.g. node scripts/bench-frontmatter-search.mjs 100,1000
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
const targetStatus = "ready-to-ship";

function noteName(i) {
  return `frontmatter-note-${String(i).padStart(6, "0")}`;
}

export function makeFrontmatterSearchVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-frontmatter-search-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const folder = i % 5 === 0 ? join(dir, "archive") : join(dir, `projects/team-${i % 12}`);
    mkdirSync(folder, { recursive: true });
    const status = i === n - 1 ? targetStatus : i % 9 === 0 ? "blocked" : "active";
    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [
        "---",
        `status: ${status}`,
        `type: ${i % 3 === 0 ? "meeting" : "project"}`,
        `priority: ${i % 5}`,
        `owner: team-${i % 12}`,
        "tags:",
        `  - frontmatter/bench`,
        `  - cohort/${i % 25}`,
        "---",
        "",
        `# ${noteName(i)}`,
        "",
        "Synthetic frontmatter search note.",
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

async function timeFrontmatterSearch(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "frontmatter-search-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldFrontmatterSearchMs = await timeCall(client, "search_by_frontmatter", {
      property: "status",
      value: targetStatus,
    });
    const warmFrontmatterSearchMs = await timeCall(client, "search_by_frontmatter", {
      property: "status",
      value: targetStatus,
    });
    const warmFolderFrontmatterSearchMs = await timeCall(client, "search_by_frontmatter", {
      property: "status",
      value: targetStatus,
      folder: "projects",
    });
    return { coldFrontmatterSearchMs, warmFrontmatterSearchMs, warmFolderFrontmatterSearchMs };
  } finally {
    await client.close();
  }
}

export async function runFrontmatterSearchBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeFrontmatterSearchVault(n);
    try {
      const timings = await timeFrontmatterSearch(vault);
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
  const rows = await runFrontmatterSearchBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold search_by_frontmatter ${r.coldFrontmatterSearchMs.toFixed(0)}ms`,
          `warm search_by_frontmatter ${r.warmFrontmatterSearchMs.toFixed(0)}ms`,
          `warm search_by_frontmatter folder=projects ${r.warmFolderFrontmatterSearchMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold search_by_frontmatter | warm search_by_frontmatter | warm search_by_frontmatter folder=projects |");
    console.log("|------:|---------------------------:|---------------------------:|-------------------------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldFrontmatterSearchMs.toFixed(0)}ms | ${r.warmFrontmatterSearchMs.toFixed(0)}ms | ${r.warmFolderFrontmatterSearchMs.toFixed(0)}ms |`,
      );
    }
  }
}
