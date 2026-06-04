// Attachment benchmark: generate throwaway attachment-heavy vaults and time
// attachment inventory tools through a real stdio MCP client.
//
// Direct use: node scripts/bench-attachments.mjs [sizes] [--json]
//   e.g. node scripts/bench-attachments.mjs 100,1000
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

function attachmentName(i) {
  const ext = i % 7 === 0 ? "pdf" : i % 5 === 0 ? "webp" : i % 3 === 0 ? "jpg" : "png";
  return `asset-${String(i).padStart(6, "0")}.${ext}`;
}

function attachmentPath(i) {
  return `assets/group-${String(i % 20).padStart(2, "0")}/${attachmentName(i)}`;
}

function noteName(i) {
  return `note-${String(i).padStart(6, "0")}`;
}

export function makeAttachmentVault(n) {
  const dir = mkdtempSync(join(tmpdir(), `ompro-attachment-bench-${n}-`));
  mkdirSync(join(dir, ".obsidian"));

  for (let i = 0; i < n; i++) {
    const rel = attachmentPath(i);
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `fixture attachment ${i}\n`.repeat((i % 5) + 1));
  }

  const noteCount = n;
  for (let i = 0; i < noteCount; i++) {
    const folder = i % 10 === 0 ? join(dir, `notes/area-${i % 50}`) : join(dir, "notes");
    mkdirSync(folder, { recursive: true });
    const referenced = attachmentPath((i * 3) % n);
    const maybeSecond = i % 4 === 0 ? `\n![diagram](${attachmentPath((i * 7) % n)})` : "";
    writeFileSync(
      join(folder, `${noteName(i)}.md`),
      [
        `# ${noteName(i)}`,
        "",
        `Primary embed: ![[${referenced}]]`,
        maybeSecond,
        "",
        "This synthetic note keeps find_unused_attachments scanning realistic.",
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

async function timeAttachments(vault, n) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "attachment-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const coldListAttachmentsMs = await timeCall(client, "list_attachments", { limit: n });
    const warmListAttachmentsMs = await timeCall(client, "list_attachments", { limit: n });
    const coldFindUnusedAttachmentsMs = await timeCall(client, "find_unused_attachments", {
      limit: 100,
      includeBytes: false,
    });
    const warmFindUnusedAttachmentsMs = await timeCall(client, "find_unused_attachments", {
      limit: 100,
      includeBytes: false,
    });
    return {
      coldListAttachmentsMs,
      warmListAttachmentsMs,
      coldFindUnusedAttachmentsMs,
      warmFindUnusedAttachmentsMs,
    };
  } finally {
    await client.close();
  }
}

export async function runAttachmentBench(sizes) {
  const rows = [];
  for (const n of sizes) {
    const vault = makeAttachmentVault(n);
    try {
      const timings = await timeAttachments(vault, n);
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
  const rows = await runAttachmentBench(sizes);
  if (asJson) {
    console.log(JSON.stringify(rows));
  } else {
    for (const r of rows) {
      console.log(
        [
          `${r.n} attachments`,
          `cold list_attachments ${r.coldListAttachmentsMs.toFixed(0)}ms`,
          `warm list_attachments ${r.warmListAttachmentsMs.toFixed(0)}ms`,
          `cold find_unused_attachments ${r.coldFindUnusedAttachmentsMs.toFixed(0)}ms`,
          `warm find_unused_attachments ${r.warmFindUnusedAttachmentsMs.toFixed(0)}ms`,
        ].join("\t"),
      );
    }
    console.log("\n| attachments + notes | cold list_attachments | warm list_attachments | cold find_unused_attachments | warm find_unused_attachments |");
    console.log("|--------------------:|----------------------:|----------------------:|-----------------------------:|-----------------------------:|");
    for (const r of rows) {
      console.log(
        `| ${r.n} | ${r.coldListAttachmentsMs.toFixed(0)}ms | ${r.warmListAttachmentsMs.toFixed(0)}ms | ${r.coldFindUnusedAttachmentsMs.toFixed(0)}ms | ${r.warmFindUnusedAttachmentsMs.toFixed(0)}ms |`,
      );
    }
  }
}
