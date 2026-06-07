// Tag validity quality benchmark: exercise frontmatter and inline tag parsing
// through a real stdio MCP client.
//
// Direct use: node scripts/bench-tag-validity-quality.mjs [--json]
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
  const dir = mkdtempSync(join(tmpdir(), "ompro-tag-validity-"));
  mkdirSync(join(dir, ".obsidian"));
  writeNote(dir, "numeric-frontmatter.md", [
    "---",
    "tags:",
    "  - 1984",
    "---",
    "Frontmatter contains a numeric-only tag value.",
  ]);
  writeNote(dir, "mixed-year.md", [
    "---",
    "tags:",
    "  - y1984",
    "---",
    "Mixed tags remain valid.",
  ]);
  writeNote(dir, "nested.md", [
    "---",
    "tags:",
    "  - project/alpha",
    "---",
    "Nested frontmatter tags remain valid.",
  ]);
  writeNote(dir, "inline-invalid.md", [
    "Inline numeric-only #1984 should not become a tag.",
  ]);
  writeNote(dir, "inline-valid.md", [
    "Inline valid #meeting tag should remain searchable.",
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
  return text.includes(`#${tag}`);
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
  const client = new Client({ name: "tag-validity-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listTags = await callText(client, "list_tags", { sortBy: "name" });
    const searchNumeric = await callText(client, "search_by_tag", {
      tag: "1984",
      includeContent: false,
      maxResults: 10,
    });
    const searchMixed = await callText(client, "search_by_tag", {
      tag: "y1984",
      includeContent: false,
      maxResults: 10,
    });
    const searchNested = await callText(client, "search_by_tag", {
      tag: "project",
      includeContent: false,
      maxResults: 10,
    });
    const searchInline = await callText(client, "search_by_tag", {
      tag: "meeting",
      includeContent: false,
      maxResults: 10,
    });

    const validSearches = [
      containsPath(searchMixed, "mixed-year.md"),
      containsPath(searchNested, "nested.md"),
      containsPath(searchInline, "inline-valid.md"),
    ];
    const validListedTags = ["y1984", "project/alpha", "meeting"].filter((tag) =>
      containsTag(listTags, tag),
    ).length;

    return {
      invalidNumericTagsListed: containsTag(listTags, "1984") ? 1 : 0,
      invalidNumericSearchMatches: containsPath(searchNumeric, "numeric-frontmatter.md") ? 1 : 0,
      validTagListRecall: validListedTags / 3,
      validSearchRecall: validSearches.filter(Boolean).length / validSearches.length,
    };
  } finally {
    await client.close();
  }
}

export async function runTagValidityQualityBench() {
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
  const metrics = await runTagValidityQualityBench();
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
