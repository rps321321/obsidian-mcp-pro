// Resolve-alias benchmark: generate throwaway alias-heavy vaults and time
// resolve_alias through a real stdio MCP client.
//
// Direct use: node scripts/bench-resolve-alias.mjs [sizes] [--json]
//   e.g. node scripts/bench-resolve-alias.mjs 100,1000
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
const targetAlias = "project atlas";

function noteName(i) {
  return `alias-note-${String(i).padStart(6, "0")}`;
}

export function makeResolveAliasVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-resolve-alias-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const folder = i % 8 === 0 ? join(dir, `people/team-${i % 32}`) : join(dir, "projects");
    mkdirSync(folder, { recursive: true });
    const aliases = [`Alias ${i}`, `Shared ${i % 25}`];
    if (i === n - 1) aliases.push(targetAlias);
    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [
        "---",
        "aliases:",
        ...aliases.map((alias) => `  - ${alias}`),
        "---",
        "",
        `# ${noteName(i)}`,
        "",
        "Synthetic alias lookup note.",
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

async function timeResolveAlias(vault, n) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "resolve-alias-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldResolveAliasMs = await timeCall(client, "resolve_alias", {
      name: targetAlias,
    });
    const warmResolveAliasMs = await timeCall(client, "resolve_alias", {
      name: targetAlias,
    });
    const warmBasenameResolveMs = await timeCall(client, "resolve_alias", {
      name: noteName(n - 1),
    });
    return { coldResolveAliasMs, warmResolveAliasMs, warmBasenameResolveMs };
  } finally {
    await client.close();
  }
}

export async function runResolveAliasBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeResolveAliasVault(n);
    try {
      const timings = await timeResolveAlias(vault, n);
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
  const rows = await runResolveAliasBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold resolve_alias ${r.coldResolveAliasMs.toFixed(0)}ms`,
          `warm resolve_alias ${r.warmResolveAliasMs.toFixed(0)}ms`,
          `warm resolve_alias basename ${r.warmBasenameResolveMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold resolve_alias | warm resolve_alias | warm resolve_alias basename |");
    console.log("|------:|-------------------:|-------------------:|----------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldResolveAliasMs.toFixed(0)}ms | ${r.warmResolveAliasMs.toFixed(0)}ms | ${r.warmBasenameResolveMs.toFixed(0)}ms |`,
      );
    }
  }
}
