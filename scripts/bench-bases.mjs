// Bases benchmark: generate throwaway vaults with one .base file and time two
// query_base calls through a real stdio MCP client.
//
// Direct use: node scripts/bench-bases.mjs [sizes] [--json]
//   e.g. node scripts/bench-bases.mjs 100,1000
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
const basePath = "bases/projects.base";

function noteName(i) {
  return `note-${String(i).padStart(6, "0")}`;
}

export function makeBaseVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-base-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));
  mkdirSync(join(dir, "bases"), { recursive: true });
  writeFileSync(
    join(dir, basePath),
    [
      "filters:",
      "  and:",
      "    - file.hasTag(\"bench\")",
      "    - status == \"active\"",
      "views:",
      "  - type: table",
      "    name: Active High",
      "    filters:",
      "      and:",
      "        - priority >= 3",
      "        - file.name.contains(\"note\")",
      "",
    ].join("\n"),
  );
  for (let i = 0; i < n; i++) {
    const folder = i % 10 === 0 ? join(dir, `area-${i % 50}`) : dir;
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    const name = noteName(i);
    const next = noteName((i + 1) % n);
    const status = i % 3 === 0 ? "done" : "active";
    const priority = i % 5;
    const tags = i % 2 === 0 ? "#bench #project" : "#bench #archive";
    writeFileSync(
      join(folder, `${name}.md`),
      [
        "---",
        `status: "${status}"`,
        `priority: ${priority}`,
        `owner: "team-${i % 8}"`,
        "---",
        "",
        `# ${name}`,
        "",
        `${tags}`,
        "",
        `Related: [[${next}]]`,
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

async function timeBaseQuery(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "base-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const args = {
      path: basePath,
      view: "Active High",
      limit: 100,
      includeFrontmatter: false,
    };
    const coldBaseMs = await timeCall(client, "query_base", args);
    const warmBaseMs = await timeCall(client, "query_base", args);
    return { coldBaseMs, warmBaseMs };
  } finally {
    await client.close();
  }
}

export async function runBaseBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeBaseVault(n);
    try {
      const timings = await timeBaseQuery(vault);
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
  const rows = await runBaseBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold query_base ${r.coldBaseMs.toFixed(0)}ms`,
          `warm query_base ${r.warmBaseMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold query_base | warm query_base |");
    console.log("|------:|----------------:|----------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldBaseMs.toFixed(0)}ms | ${r.warmBaseMs.toFixed(0)}ms |`,
      );
    }
  }
}
