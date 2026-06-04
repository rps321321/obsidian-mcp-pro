// Section-list benchmark: generate throwaway vaults with one heading-heavy note
// and time list_sections through a real stdio MCP client.
//
// Direct use: node scripts/bench-sections.mjs [heading-counts] [--json]
//   e.g. node scripts/bench-sections.mjs 100,1000
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

function headingLevel(i) {
  if (i % 25 === 0) return 1;
  if (i % 10 === 0) return 2;
  if (i % 3 === 0) return 3;
  return 4;
}

function makeSectionsNote(headingCount) {
  const lines = [
    "---",
    "title: Section List Bench",
    "---",
    "",
  ];

  for (let i = 0; i < headingCount; i++) {
    const level = headingLevel(i);
    lines.push(`${"#".repeat(level)} Heading ${String(i).padStart(5, "0")}`);
    lines.push(`Body paragraph for heading ${i}.`);
    lines.push("");
  }

  return lines.join("\n");
}

export function makeSectionsVault(headingCount) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-sections-bench-${headingCount}-`));
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, "sections.md"), makeSectionsNote(headingCount));
  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeSections(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "sections-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldListSectionsMs = await timeCall(client, "list_sections", {
      path: "sections.md",
    });
    const warmListSectionsMs = await timeCall(client, "list_sections", {
      path: "sections.md",
    });
    return { coldListSectionsMs, warmListSectionsMs };
  } finally {
    await client.close();
  }
}

export async function runSectionsBench(headingCounts) {
  const rows = [];
  for (const headings of headingCounts) {
    const vault = makeSectionsVault(headings);
    try {
      const timings = await timeSections(vault);
      rows.push({ headings, ...timings });
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
  const headingCounts = (sizesArg ?? "100,1000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rows = await runSectionsBench(headingCounts);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.headings} headings`,
          `cold list_sections ${r.coldListSectionsMs.toFixed(0)}ms`,
          `warm list_sections ${r.warmListSectionsMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| headings | cold list_sections | warm list_sections |");
    console.log("|---------:|-------------------:|-------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.headings} | ${r.coldListSectionsMs.toFixed(0)}ms | ${r.warmListSectionsMs.toFixed(0)}ms |`,
      );
    }
  }
}
