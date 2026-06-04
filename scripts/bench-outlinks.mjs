// Outlinks benchmark: generate throwaway link-heavy vaults and time
// get_outlinks through a real stdio MCP client.
//
// Direct use: node scripts/bench-outlinks.mjs [sizes] [--json]
//   e.g. node scripts/bench-outlinks.mjs 100,1000
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
  return `outlink-note-${String(i).padStart(6, "0")}`;
}

export function makeOutlinksVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-outlinks-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const folder = i % 6 === 0 ? join(dir, "reference") : join(dir, `projects/team-${i % 20}`);
    mkdirSync(folder, { recursive: true });
    const next = noteName((i + 1) % n);
    const prev = noteName((i + n - 1) % n);
    const aliasTarget = `Alias ${String((i + 17) % n).padStart(6, "0")}`;
    const embed = i % 17 === 0 ? ` ![[${noteName((i + 3) % n)}]]` : "";
    const broken = i % 31 === 0 ? ` [[missing-outlink-${i}]]` : "";

    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [
        "---",
        "aliases:",
        `  - Alias ${String(i).padStart(6, "0")}`,
        "---",
        "",
        `# ${noteName(i)}`,
        "",
        `Links: [[${next}]] [[${prev}]] [[${aliasTarget}]]${embed}${broken}`,
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

async function timeOutlinks(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "outlinks-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldOutlinksMs = await timeCall(client, "get_outlinks", {
      path: `${noteName(0)}.md`,
    });
    const warmOutlinksMs = await timeCall(client, "get_outlinks", {
      path: `${noteName(1)}.md`,
    });
    const warmMixedOutlinksMs = await timeCall(client, "get_outlinks", {
      path: `${noteName(31)}.md`,
    });
    return { coldOutlinksMs, warmOutlinksMs, warmMixedOutlinksMs };
  } finally {
    await client.close();
  }
}

export async function runOutlinksBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeOutlinksVault(n);
    try {
      const timings = await timeOutlinks(vault);
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
  const rows = await runOutlinksBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} notes`,
          `cold get_outlinks ${r.coldOutlinksMs.toFixed(0)}ms`,
          `warm get_outlinks ${r.warmOutlinksMs.toFixed(0)}ms`,
          `warm get_outlinks mixed ${r.warmMixedOutlinksMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| notes | cold get_outlinks | warm get_outlinks | warm get_outlinks mixed |");
    console.log("|------:|------------------:|------------------:|------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldOutlinksMs.toFixed(0)}ms | ${r.warmOutlinksMs.toFixed(0)}ms | ${r.warmMixedOutlinksMs.toFixed(0)}ms |`,
      );
    }
  }
}
