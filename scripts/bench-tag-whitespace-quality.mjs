// Tag whitespace quality benchmark: exercise frontmatter tag values containing
// spaces through a real stdio MCP client.
//
// Direct use: node scripts/bench-tag-whitespace-quality.mjs [--json]
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
  const dir = mkdtempSync(join(tmpdir(), "ompro-tag-whitespace-"));
  mkdirSync(join(dir, ".obsidian"));
  writeNote(dir, "space-frontmatter.md", [
    "---",
    "tags:",
    "  - \"project alpha\"",
    "---",
    "Frontmatter contains a space-separated tag value.",
  ]);
  writeNote(dir, "hyphen-frontmatter.md", [
    "---",
    "tags:",
    "  - project-alpha",
    "---",
    "Hyphenated tags remain valid.",
  ]);
  writeNote(dir, "underscore-frontmatter.md", [
    "---",
    "tags:",
    "  - project_alpha",
    "---",
    "Underscore tags remain valid.",
  ]);
  writeNote(dir, "nested.md", [
    "---",
    "tags:",
    "  - project/alpha",
    "---",
    "Nested frontmatter tags remain valid.",
  ]);
  writeNote(dir, "inline-valid.md", [
    "Inline valid #meeting-notes tag should remain searchable.",
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
  const client = new Client({ name: "tag-whitespace-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listTags = await callText(client, "list_tags", { sortBy: "name" });
    const searchWhitespace = await callText(client, "search_by_tag", {
      tag: "project alpha",
      includeContent: false,
      maxResults: 10,
    });
    const searchHyphen = await callText(client, "search_by_tag", {
      tag: "project-alpha",
      includeContent: false,
      maxResults: 10,
    });
    const searchUnderscore = await callText(client, "search_by_tag", {
      tag: "project_alpha",
      includeContent: false,
      maxResults: 10,
    });
    const searchNested = await callText(client, "search_by_tag", {
      tag: "project",
      includeContent: false,
      maxResults: 10,
    });
    const searchInline = await callText(client, "search_by_tag", {
      tag: "meeting-notes",
      includeContent: false,
      maxResults: 10,
    });

    const validSearches = [
      containsPath(searchHyphen, "hyphen-frontmatter.md"),
      containsPath(searchUnderscore, "underscore-frontmatter.md"),
      containsPath(searchNested, "nested.md"),
      containsPath(searchInline, "inline-valid.md"),
    ];
    const validListedTags = [
      "project-alpha",
      "project_alpha",
      "project/alpha",
      "meeting-notes",
    ].filter((tag) => containsTag(listTags, tag)).length;

    return {
      invalidWhitespaceTagsListed: containsTag(listTags, "project alpha") ? 1 : 0,
      invalidWhitespaceSearchMatches: containsPath(searchWhitespace, "space-frontmatter.md") ? 1 : 0,
      validTagListRecall: validListedTags / 4,
      validSearchRecall: validSearches.filter(Boolean).length / validSearches.length,
    };
  } finally {
    await client.close();
  }
}

export async function runTagWhitespaceQualityBench() {
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
  const metrics = await runTagWhitespaceQualityBench();
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
