// Recent-notes benchmark: generate throwaway vaults with deterministic mtimes
// and time get_recent_notes through a real stdio MCP client.
//
// Direct use: node scripts/bench-recent-notes.mjs [sizes] [--json]
//   e.g. node scripts/bench-recent-notes.mjs 100,1000
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

export function makeRecentNotesVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-recent-notes-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));
  const now = Date.now();

  for (let i = 0; i < n; i++) {
    const folder = i % 8 === 0 ? join(dir, `projects/area-${i % 40}`) : join(dir, "journal");
    mkdirSync(folder, { recursive: true });
    const fullPath = join(folder, `${noteName(i)}.md`);
    writeFileSync(
      fullPath,
      [
        `# ${noteName(i)}`,
        "",
        `Updated synthetic note ${i}.`,
        "",
        i % 11 === 0 ? "#recent/target" : "#recent/bench",
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

async function timeRecentNotes(vault, n) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "recent-notes-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const limit = Math.min(n, 1000);
    const coldGetRecentNotesMs = await timeCall(client, "get_recent_notes", { limit });
    const warmGetRecentNotesMs = await timeCall(client, "get_recent_notes", { limit });
    const warmSinceRecentNotesMs = await timeCall(client, "get_recent_notes", {
      limit,
      since: "7d",
    });
    return { coldGetRecentNotesMs, warmGetRecentNotesMs, warmSinceRecentNotesMs };
  } finally {
    await client.close();
  }
}

export async function runRecentNotesBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeRecentNotesVault(n);
    try {
      const timings = await timeRecentNotes(vault, n);
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
  const rows = await runRecentNotesBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold get_recent_notes ${r.coldGetRecentNotesMs.toFixed(0)}ms`,
          `warm get_recent_notes ${r.warmGetRecentNotesMs.toFixed(0)}ms`,
          `warm get_recent_notes since=7d ${r.warmSinceRecentNotesMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold get_recent_notes | warm get_recent_notes | warm get_recent_notes since=7d |");
    console.log("|------:|----------------------:|----------------------:|-------------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldGetRecentNotesMs.toFixed(0)}ms | ${r.warmGetRecentNotesMs.toFixed(0)}ms | ${r.warmSinceRecentNotesMs.toFixed(0)}ms |`,
      );
    }
  }
}
