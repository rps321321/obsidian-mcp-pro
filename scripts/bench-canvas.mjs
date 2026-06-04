// Canvas benchmark: generate throwaway Obsidian canvas files and time two
// read_canvas calls through a real stdio MCP client.
//
// Direct use: node scripts/bench-canvas.mjs [sizes] [--json]
//   e.g. node scripts/bench-canvas.mjs 100,1000
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
const canvasPath = "boards/map.canvas";

function nodeId(i) {
  return `node-${String(i).padStart(6, "0")}`;
}

export function makeCanvasVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-canvas-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));
  mkdirSync(join(dir, "boards"), { recursive: true });

  const nodes = [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    const id = nodeId(i);
    const type = i % 7 === 0 ? "file" : i % 11 === 0 ? "group" : "text";
    const node = {
      id,
      type,
      x: (i % 50) * 240,
      y: Math.floor(i / 50) * 180,
      width: type === "group" ? 460 : 220,
      height: type === "group" ? 220 : 120,
    };
    if (type === "file") {
      node.file = `notes/${id}.md`;
    } else if (type === "group") {
      node.label = `Group ${i % 12}`;
      node.color = String((i % 6) + 1);
    } else {
      node.text = `Canvas note ${i}\n\nThis synthetic node keeps read_canvas output realistic.`;
    }
    nodes.push(node);
    if (i > 0) {
      edges.push({
        id: `edge-${String(i).padStart(6, "0")}`,
        fromNode: nodeId(i - 1),
        toNode: id,
        label: i % 10 === 0 ? `step-${i}` : undefined,
      });
    }
  }

  writeFileSync(join(dir, canvasPath), JSON.stringify({ nodes, edges }, null, 2));
  return dir;
}

async function timeCall(client, name, args) {
  const start = performance.now();
  await client.callTool({ name, arguments: args });
  return performance.now() - start;
}

async function timeCanvas(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "canvas-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldReadCanvasMs = await timeCall(client, "read_canvas", { path: canvasPath });
    const warmReadCanvasMs = await timeCall(client, "read_canvas", { path: canvasPath });
    return { coldReadCanvasMs, warmReadCanvasMs };
  } finally {
    await client.close();
  }
}

export async function runCanvasBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeCanvasVault(n);
    try {
      const timings = await timeCanvas(vault);
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
  const rows = await runCanvasBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} nodes`,
          `cold read_canvas ${r.coldReadCanvasMs.toFixed(0)}ms`,
          `warm read_canvas ${r.warmReadCanvasMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| nodes | cold read_canvas | warm read_canvas |");
    console.log("|------:|-----------------:|-----------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldReadCanvasMs.toFixed(0)}ms | ${r.warmReadCanvasMs.toFixed(0)}ms |`,
      );
    }
  }
}
