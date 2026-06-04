// Note-fragment benchmark: generate throwaway vaults with one long note and
// time get_note fragment reads through a real stdio MCP client.
//
// Direct use: node scripts/bench-note-fragments.mjs [line-counts] [--json]
//   e.g. node scripts/bench-note-fragments.mjs 1000,10000
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

function makeLongNote(lineCount) {
  const lines = [
    "---",
    "title: Note Fragment Bench",
    "tags:",
    "  - fragment/bench",
    "---",
    "",
    "# Note Fragment Bench",
    "",
  ];
  const sectionEvery = Math.max(100, Math.floor(lineCount / 10));
  const targetBlockLine = Math.max(40, Math.floor(lineCount * 0.7));

  for (let i = 1; i <= lineCount; i++) {
    if (i % sectionEvery === 0) {
      lines.push(`## Section ${i / sectionEvery}`);
    }
    if (i === targetBlockLine) {
      lines.push(`Target paragraph ${i} carries the block marker for fragment lookup. ^fragment-target`);
    }
    lines.push(`Line ${String(i).padStart(6, "0")} has predictable fixture text for note fragment slicing.`);
  }

  return lines.join("\n");
}

export function makeNoteFragmentVault(lineCount) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-note-fragment-bench-${lineCount}-`));
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, "long.md"), makeLongNote(lineCount));
  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeNoteFragments(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "note-fragment-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldLineFragmentMs = await timeCall(client, "get_note", {
      path: "long.md",
      lines: "40-60",
    });
    const warmLineFragmentMs = await timeCall(client, "get_note", {
      path: "long.md",
      lines: "40-60",
    });
    const warmSectionFragmentMs = await timeCall(client, "get_note", {
      path: "long.md",
      section: "Section 7",
    });
    const warmBlockFragmentMs = await timeCall(client, "get_note", {
      path: "long.md",
      block: "fragment-target",
    });
    return {
      coldLineFragmentMs,
      warmLineFragmentMs,
      warmSectionFragmentMs,
      warmBlockFragmentMs,
    };
  } finally {
    await client.close();
  }
}

export async function runNoteFragmentBench(lineCounts) {
  const rows = [];
  for (const lines of lineCounts) {
    const vault = makeNoteFragmentVault(lines);
    try {
      const timings = await timeNoteFragments(vault);
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
  const lineCounts = (sizesArg ?? "1000,10000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rows = await runNoteFragmentBench(lineCounts);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.lines} lines`,
          `cold get_note lines ${r.coldLineFragmentMs.toFixed(0)}ms`,
          `warm get_note lines ${r.warmLineFragmentMs.toFixed(0)}ms`,
          `warm get_note section ${r.warmSectionFragmentMs.toFixed(0)}ms`,
          `warm get_note block ${r.warmBlockFragmentMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| lines | cold get_note lines | warm get_note lines | warm get_note section | warm get_note block |");
    console.log("|------:|--------------------:|--------------------:|----------------------:|--------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.lines} | ${r.coldLineFragmentMs.toFixed(0)}ms | ${r.warmLineFragmentMs.toFixed(0)}ms | ${r.warmSectionFragmentMs.toFixed(0)}ms | ${r.warmBlockFragmentMs.toFixed(0)}ms |`,
      );
    }
  }
}
