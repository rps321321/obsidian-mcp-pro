// List-notes benchmark: generate throwaway vaults and time list_notes through
// a real stdio MCP client.
//
// Direct use: node scripts/bench-list-notes.mjs [sizes] [--json]
//   e.g. node scripts/bench-list-notes.mjs 100,1000
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
  return `list-note-${String(i).padStart(6, "0")}`;
}

export function makeListNotesVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-list-notes-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const folder = i % 5 === 0 ? join(dir, "reference") : join(dir, `projects/team-${i % 20}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [`# ${noteName(i)}`, "", `Team: ${i % 20}`, ""].join("\n"),
    );
  }

  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeListNotes(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "list-notes-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldListMs = await timeCall(client, "list_notes", {
      limit: 10000,
    });
    const warmListMs = await timeCall(client, "list_notes", {
      limit: 10000,
    });
    const warmFolderListMs = await timeCall(client, "list_notes", {
      folder: "projects/team-7",
      limit: 10000,
    });
    return { coldListMs, warmListMs, warmFolderListMs };
  } finally {
    await client.close();
  }
}

export async function runListNotesBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeListNotesVault(n);
    try {
      const timings = await timeListNotes(vault);
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
  const rows = await runListNotesBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold list_notes ${r.coldListMs.toFixed(0)}ms`,
          `warm list_notes ${r.warmListMs.toFixed(0)}ms`,
          `warm folder list_notes ${r.warmFolderListMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold list_notes | warm list_notes | warm folder list_notes |");
    console.log("|------:|----------------:|----------------:|-----------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldListMs.toFixed(0)}ms | ${r.warmListMs.toFixed(0)}ms | ${r.warmFolderListMs.toFixed(0)}ms |`,
      );
    }
  }
}
