#!/usr/bin/env node
// Publish using an npm token from the environment without writing the token to
// project files. The temp npmrc contains ${NPM_TOKEN}, not the token value.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage: node scripts/publish-npm-from-env.mjs [--dry-run] [--tag <dist-tag>]

Requires NPM_TOKEN or NODE_AUTH_TOKEN in the environment.

Examples:
  $env:NPM_TOKEN = "npm_xxx"
  node scripts/publish-npm-from-env.mjs --dry-run
  node scripts/publish-npm-from-env.mjs
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  return value;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: options.encoding,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function runQuiet(command, commandArgs) {
  return run(command, commandArgs, { encoding: "utf-8", stdio: "pipe" }).stdout.trim();
}

function readWindowsUserEnv(name) {
  if (process.platform !== "win32") return "";
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0 || result.error) return "";
  return result.stdout.trim();
}

function readToken() {
  return (
    process.env.NPM_TOKEN ||
    process.env.NODE_AUTH_TOKEN ||
    readWindowsUserEnv("NPM_TOKEN") ||
    readWindowsUserEnv("NODE_AUTH_TOKEN")
  );
}

function npmArgs(commandArgs) {
  if (process.platform !== "win32") {
    return { command: "npm", args: commandArgs };
  }

  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "npm", ...commandArgs],
  };
}

function runNpm(commandArgs, options = {}) {
  const npm = npmArgs(commandArgs);
  return run(npm.command, npm.args, options);
}

function withoutUserconfig(commandArgs) {
  return commandArgs.filter((arg, index) => arg !== "--userconfig" && commandArgs[index - 1] !== "--userconfig");
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const allowedArgs = new Set(["--dry-run", "--tag"]);
for (const arg of args) {
  if (!arg.startsWith("--")) continue;
  if (!allowedArgs.has(arg)) fail(`Unsupported option: ${arg}`);
}

const dryRun = args.includes("--dry-run");
const distTag = readOption("--tag");
const token = readToken();

if (!token) {
  fail("Set NPM_TOKEN or NODE_AUTH_TOKEN before publishing.");
}

const branch = runQuiet("git", ["branch", "--show-current"]);
if (branch !== "master") {
  fail(`Refusing to publish from ${branch || "detached HEAD"}; switch to master first.`);
}

const dirty = runQuiet("git", ["status", "--porcelain"]);
if (dirty) {
  fail("Refusing to publish with uncommitted changes.");
}

const tempDir = mkdtempSync(join(tmpdir(), "ompro-npm-publish-"));
const userconfig = join(tempDir, "npmrc");
const publishEnv = {
  ...process.env,
  NPM_TOKEN: token,
  NODE_AUTH_TOKEN: token,
  NPM_CONFIG_USERCONFIG: userconfig,
};

writeFileSync(
  userconfig,
  [
    "registry=https://registry.npmjs.org/",
    "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    "",
  ].join("\n"),
  { encoding: "utf-8", mode: 0o600 },
);

try {
  console.log("> npm run verify");
  runNpm(["run", "verify"]);

  console.log("> npm whoami");
  runNpm(["whoami", "--userconfig", userconfig], { env: publishEnv });

  const publishArgs = ["publish", "--access", "public", "--userconfig", userconfig];
  if (distTag) publishArgs.push("--tag", distTag);
  if (dryRun) publishArgs.push("--dry-run");

  console.log(`> npm ${withoutUserconfig(publishArgs).join(" ")}`);
  runNpm(publishArgs, { env: publishEnv });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
