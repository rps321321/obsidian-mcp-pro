// Daily-note benchmark: generate throwaway vaults with Obsidian daily-note
// config and time get_daily_note through a real stdio MCP client.
//
// Direct use: node scripts/bench-daily-notes.mjs [line-counts] [--json]
//   e.g. node scripts/bench-daily-notes.mjs 100,1000
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

function makeDailyNote(date, lineCount) {
  const lines = [
    "---",
    `date: ${date}`,
    "tags:",
    "  - daily/bench",
    "---",
    "",
    `# Daily ${date}`,
    "",
  ];

  for (let i = 0; i < lineCount; i++) {
    lines.push(`- Synthetic daily-note line ${String(i).padStart(5, "0")}`);
  }

  return lines.join("\n");
}

export function makeDailyNotesVault(lineCount) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-daily-notes-bench-${lineCount}-`));
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  mkdirSync(join(dir, "daily"), { recursive: true });
  writeFileSync(
    join(dir, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "daily", format: "YYYY-MM-DD" }),
  );
  writeFileSync(join(dir, "daily", "2026-04-24.md"), makeDailyNote("2026-04-24", lineCount));
  writeFileSync(join(dir, "daily", "2026-04-25.md"), makeDailyNote("2026-04-25", lineCount));
  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeDailyNotes(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "daily-notes-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldDailyNoteMs = await timeCall(client, "get_daily_note", {
      date: "2026-04-24",
    });
    const warmDailyNoteMs = await timeCall(client, "get_daily_note", {
      date: "2026-04-24",
    });
    const warmOtherDateDailyNoteMs = await timeCall(client, "get_daily_note", {
      date: "2026-04-25",
    });
    return { coldDailyNoteMs, warmDailyNoteMs, warmOtherDateDailyNoteMs };
  } finally {
    await client.close();
  }
}

export async function runDailyNotesBench(lineCounts) {
  const rows = [];
  for (const lines of lineCounts) {
    const vault = makeDailyNotesVault(lines);
    try {
      const timings = await timeDailyNotes(vault);
      rows.push({ lines, ...timings });
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
  const lineCounts = (sizesArg ?? "100,1000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rows = await runDailyNotesBench(lineCounts);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.lines} lines`,
          `cold get_daily_note ${r.coldDailyNoteMs.toFixed(0)}ms`,
          `warm get_daily_note ${r.warmDailyNoteMs.toFixed(0)}ms`,
          `warm get_daily_note other date ${r.warmOtherDateDailyNoteMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| lines | cold get_daily_note | warm get_daily_note | warm get_daily_note other date |");
    console.log("|------:|--------------------:|--------------------:|-------------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.lines} | ${r.coldDailyNoteMs.toFixed(0)}ms | ${r.warmDailyNoteMs.toFixed(0)}ms | ${r.warmOtherDateDailyNoteMs.toFixed(0)}ms |`,
      );
    }
  }
}
