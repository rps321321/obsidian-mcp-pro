import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PRIVATE_PREFIXES = [
  ".agent/",
  ".codex/",
  "docs/rnd/",
  "docs/outreach/",
  "docs/drafts/",
];

const PRIVATE_EXACT_PATHS = new Set([
  "AGENT_GOAL.md",
  "COMPETITIVE.md",
  "DEVELOPMENT_GOAL.md",
  "docs/AGENT_GOAL.md",
  "docs/COMPETITIVE.md",
  "docs/DEVELOPMENT_GOAL.md",
  "docs/devto-article.md",
  "docs/reddit-claudeai-post.md",
  "docs/reddit-localllama-post.md",
  "docs/reddit-obsidianmd-post.md",
  "docs/twitter-thread.md",
]);

function normalizeGitPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isPrivatePath(filePath) {
  const normalized = normalizeGitPath(filePath);

  return (
    normalized === ".agent" ||
    normalized === ".codex" ||
    PRIVATE_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    PRIVATE_EXACT_PATHS.has(normalized)
  );
}

export function findPrivatePaths(filePaths) {
  return filePaths
    .map(normalizeGitPath)
    .filter((filePath) => isPrivatePath(filePath))
    .sort();
}

function stagedPaths() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    { encoding: "utf8" }
  );

  return output.split("\0").filter(Boolean);
}

export function checkStagedPaths(filePaths = stagedPaths()) {
  const blocked = findPrivatePaths(filePaths);

  if (blocked.length === 0) {
    return;
  }

  console.error(
    "Commit blocked: maintainer-only files must remain local and ignored."
  );
  for (const filePath of blocked) {
    console.error(`- ${filePath}`);
  }
  console.error(
    "Move these files under .agent/ or unstage them before committing."
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (import.meta.url === invokedPath) {
  checkStagedPaths();
}
