// Tag leading-number quality benchmark: exercise numeric-leading inline tags
// through a real stdio MCP client.
//
// Direct use: node scripts/bench-tag-leading-number-quality.mjs [--json]
// Run after `npm run build`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");

function writeNote(vault, name, lines) {
  writeFileSync(join(vault, name), `${lines.join("\n")}\n`);
}

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), "ompro-tag-leading-number-"));
  mkdirSync(join(dir, ".obsidian"));
  writeNote(dir, "one-a.md", [
    "Inline valid numeric-leading #1a tag.",
  ]);
  writeNote(dir, "year-goals.md", [
    "Inline valid numeric-leading #2026-goals tag.",
  ]);
  writeNote(dir, "numeric-only.md", [
    "Inline numeric-only #1984 should not become a tag.",
  ]);
  writeNote(dir, "numeric-nested-only.md", [
    "Inline numeric-only nested #1984/2020 should not become a tag.",
  ]);
  writeNote(dir, "ordinary.md", [
    "Ordinary inline #a1 tag should remain searchable.",
  ]);
  return dir;
}

function textOf(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function containsPath(text, notePath) {
  return text.includes(notePath);
}

function containsTag(text, tag) {
  return new RegExp(`(^|\\n)#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\(`).test(text);
}

async function callText(client, name, args) {
  return textOf(await client.callTool({ name, arguments: args }));
}

async function measure(vault) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  const client = new Client({ name: "tag-leading-number-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listTags = await callText(client, "list_tags", { sortBy: "name" });
    const searchOneA = await callText(client, "search_by_tag", {
      tag: "1a",
      includeContent: false,
      maxResults: 10,
    });
    const searchYearGoals = await callText(client, "search_by_tag", {
      tag: "2026-goals",
      includeContent: false,
      maxResults: 10,
    });
    const searchNumericOnly = await callText(client, "search_by_tag", {
      tag: "1984",
      includeContent: false,
      maxResults: 10,
    });
    const searchOrdinary = await callText(client, "search_by_tag", {
      tag: "a1",
      includeContent: false,
      maxResults: 10,
    });

    const numericLeadingListed = ["1a", "2026-goals"].filter((tag) =>
      containsTag(listTags, tag),
    ).length;
    const numericLeadingSearches = [
      containsPath(searchOneA, "one-a.md"),
      containsPath(searchYearGoals, "year-goals.md"),
    ];

    return {
      numericLeadingTagListRecall: numericLeadingListed / 2,
      numericLeadingSearchRecall: numericLeadingSearches.filter(Boolean).length / numericLeadingSearches.length,
      invalidNumericOnlyTagsListed: containsTag(listTags, "1984") || containsTag(listTags, "1984/2020") ? 1 : 0,
      invalidNumericOnlySearchMatches: containsPath(searchNumericOnly, "numeric-only.md")
        || containsPath(searchNumericOnly, "numeric-nested-only.md")
        ? 1
        : 0,
      ordinarySearchRecall: containsPath(searchOrdinary, "ordinary.md") ? 1 : 0,
    };
  } finally {
    await client.close();
  }
}

export async function runTagLeadingNumberQualityBench() {
  const vault = makeVault();
  try {
    return await measure(vault);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(entry)) {
    console.error("build/index.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const asJson = process.argv.slice(2).includes("--json");
  const metrics = await runTagLeadingNumberQualityBench();
  if (asJson) {
    console.log(JSON.stringify(metrics));
  } else {
    console.log("| metric | value |");
    console.log("|---|---:|");
    for (const [name, value] of Object.entries(metrics)) {
      console.log(`| ${name} | ${value} |`);
    }
  }
}
