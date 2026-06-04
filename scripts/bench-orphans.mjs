// Orphan-discovery benchmark: generate throwaway link-heavy vaults and time
// find_orphans through a real stdio MCP client.
//
// Direct use: node scripts/bench-orphans.mjs [sizes] [--json]
//   e.g. node scripts/bench-orphans.mjs 100,1000
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
  return `orphan-note-${String(i).padStart(6, "0")}`;
}

export function makeOrphanVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-orphan-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const folder = i % 7 === 0 ? join(dir, "archive") : join(dir, `areas/area-${i % 16}`);
    mkdirSync(folder, { recursive: true });

    const links = [];
    if (i % 50 === 0) {
      // Fully isolated.
    } else if (i % 50 === 1) {
      // No outgoing links, but the next note points back here.
    } else if (i % 50 === 3) {
      // Has outgoing links, with no planned backlinks.
      links.push(noteName(0));
    } else {
      links.push(noteName((i + 1) % n));
      links.push(noteName((i + n - 1) % n));
      if (i % 50 === 2) links.push(noteName(i - 1));
    }

    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [
        "---",
        `status: ${i % 5 === 0 ? "archive" : "active"}`,
        "---",
        "",
        `# ${noteName(i)}`,
        "",
        links.length > 0 ? `Links: ${links.map((link) => `[[${link}]]`).join(" ")}` : "No deliberate links.",
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

async function timeOrphans(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "orphan-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldOrphansMs = await timeCall(client, "find_orphans", {
      includeOutlinksCheck: true,
      maxResults: 200,
    });
    const warmOrphansMs = await timeCall(client, "find_orphans", {
      includeOutlinksCheck: true,
      maxResults: 200,
    });
    const warmBacklinkOnlyOrphansMs = await timeCall(client, "find_orphans", {
      includeOutlinksCheck: false,
      maxResults: 200,
    });
    return { coldOrphansMs, warmOrphansMs, warmBacklinkOnlyOrphansMs };
  } finally {
    await client.close();
  }
}

export async function runOrphanBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeOrphanVault(n);
    try {
      const timings = await timeOrphans(vault);
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
  const rows = await runOrphanBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold find_orphans ${r.coldOrphansMs.toFixed(0)}ms`,
          `warm find_orphans ${r.warmOrphansMs.toFixed(0)}ms`,
          `warm find_orphans backlink-only ${r.warmBacklinkOnlyOrphansMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold find_orphans | warm find_orphans | warm find_orphans backlink-only |");
    console.log("|------:|------------------:|------------------:|--------------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldOrphansMs.toFixed(0)}ms | ${r.warmOrphansMs.toFixed(0)}ms | ${r.warmBacklinkOnlyOrphansMs.toFixed(0)}ms |`,
      );
    }
  }
}
