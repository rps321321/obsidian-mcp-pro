// Section-read benchmark: generate throwaway vaults with one heading-heavy note
// and time get_note section reads through a real stdio MCP client.
//
// Direct use: node scripts/bench-section-reads.mjs [section-counts] [--json]
//   e.g. node scripts/bench-section-reads.mjs 100,1000
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

function sectionLevel(i) {
  if (i % 25 === 0) return 1;
  if (i % 10 === 0) return 2;
  if (i % 3 === 0) return 3;
  return 4;
}

function makeSectionReadNote(sectionCount) {
  const lines = [
    "---",
    "title: Section Read Bench",
    "---",
    "",
  ];

  for (let i = 0; i < sectionCount; i++) {
    const level = sectionLevel(i);
    lines.push(`${"#".repeat(level)} Section ${String(i).padStart(5, "0")}`);
    lines.push(`First body line for section ${i}.`);
    lines.push(`Second body line for section ${i}.`);
    lines.push("");
  }

  return lines.join("\n");
}

export function makeSectionReadVault(sectionCount) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-section-read-bench-${sectionCount}-`));
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, "sections.md"), makeSectionReadNote(sectionCount));
  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeSectionReads(vault, sectionCount) {
  const lateSection = `Section ${String(Math.floor(sectionCount * 0.9)).padStart(5, "0")}`;
  const earlySection = "Section 00010";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "section-read-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldLateSectionMs = await timeCall(client, "get_note", {
      path: "sections.md",
      section: lateSection,
    });
    const warmLateSectionMs = await timeCall(client, "get_note", {
      path: "sections.md",
      section: lateSection,
    });
    const warmEarlySectionMs = await timeCall(client, "get_note", {
      path: "sections.md",
      section: earlySection,
    });
    return { coldLateSectionMs, warmLateSectionMs, warmEarlySectionMs };
  } finally {
    await client.close();
  }
}

export async function runSectionReadBench(sectionCounts) {
  const rows = [];
  for (const sections of sectionCounts) {
    const vault = makeSectionReadVault(sections);
    try {
      const timings = await timeSectionReads(vault, sections);
      rows.push({ sections, ...timings });
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
  const sectionCounts = (sizesArg ?? "100,1000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 10);
  const rows = await runSectionReadBench(sectionCounts);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.sections} sections`,
          `cold late get_note section ${r.coldLateSectionMs.toFixed(0)}ms`,
          `warm late get_note section ${r.warmLateSectionMs.toFixed(0)}ms`,
          `warm early get_note section ${r.warmEarlySectionMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| sections | cold late get_note section | warm late get_note section | warm early get_note section |");
    console.log("|---------:|---------------------------:|---------------------------:|----------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.sections} | ${r.coldLateSectionMs.toFixed(0)}ms | ${r.warmLateSectionMs.toFixed(0)}ms | ${r.warmEarlySectionMs.toFixed(0)}ms |`,
      );
    }
  }
}
