// Performance harness: generate throwaway vaults of increasing size and time a
// real vault-wide operation (search_notes, which lists + reads every note) through
// the stdio client. Exports runBench() so the perf gate can reuse it.
//
// Direct use: node scripts/bench.mjs [sizes] [--json]
//   e.g. node scripts/bench.mjs 100,1000,10000
// Run after `npm run build`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");

export function makeVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian")); // valid vault so the server serves this, not an auto-detected one
  for (let i = 0; i < n; i++) {
    const sub = i % 10 === 0 ? join(dir, `folder-${i % 50}`) : dir;
    if (sub !== dir && !existsSync(sub)) mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, `note-${String(i).padStart(6, "0")}.md`),
      `# Note ${i}\n\n[[note-${(i + 1) % n}]] tags:: #t${i % 20}\n\nThe quick brown fox number ${i}.\n`,
    );
  }
  return dir;
}

async function timeSearch(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const cold = performance.now();
    await client.callTool({ name: "search_notes", arguments: { query: "fox", maxResults: 50 } });
    const coldMs = performance.now() - cold;
    const warm = performance.now();
    await client.callTool({ name: "search_notes", arguments: { query: "quick", maxResults: 50 } });
    const warmMs = performance.now() - warm;
    return { coldMs, warmMs };
  } finally {
    await client.close();
  }
}

export async function runBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeVault(n);
    try {
      const { coldMs, warmMs } = await timeSearch(vault);
      rows.push({ n, coldMs, warmMs });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  }
  return rows;
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(entry)) {
    console.error("build/index.js missing — run `npm run build` first.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const sizesArg = args.find((a) => !a.startsWith("--"));
  const sizes = (sizesArg ?? "100,1000").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  const rows = await runBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) console.log(`${r.n} notes\tcold ${r.coldMs.toFixed(0)}ms\twarm ${r.warmMs.toFixed(0)}ms`);
    console.log("\n| notes | cold search | warm search |");
    console.log("|------:|------------:|------------:|");
    for (const r of rows) console.log(`| ${r.n} | ${r.coldMs.toFixed(0)}ms | ${r.warmMs.toFixed(0)}ms |`);
  }
}
