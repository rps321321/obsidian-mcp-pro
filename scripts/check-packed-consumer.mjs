import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-packed-"));

function npm(args, cwd) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? "powershell.exe" : "npm",
    windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$taskNpmArguments = [string[]](ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())); & npm.cmd @taskNpmArguments; exit $LASTEXITCODE",
        ]
      : args,
    {
      cwd,
      encoding: "utf8",
      input: windows ? JSON.stringify(args) : undefined,
      timeout: 180_000,
    }
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

try {
  npm(["run", "build"], root);
  npm(["pack", "--json", "--pack-destination", temporary], root);
  const archives = (await fs.readdir(temporary)).filter((name) =>
    name.endsWith(".tgz")
  );
  assert.equal(archives.length, 1, "exactly one package tarball was produced");
  const consumer = path.join(temporary, "consumer");
  await fs.mkdir(consumer);
  await fs.writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "obsidian-packed-consumer-test",
      version: "1.0.0",
      private: true,
      type: "module",
    })
  );
  npm(
    [
      "install",
      "--save-exact",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "@modelcontextprotocol/sdk@1.29.0",
    ],
    consumer
  );
  npm(
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(temporary, archives[0]),
    ],
    consumer
  );
  await assert.rejects(
    fs.access(path.join(consumer, "node_modules", "vitest"))
  );
  await fs.copyFile(
    new URL("./packed-consumer-probe.mjs", import.meta.url),
    path.join(consumer, "probe.mjs")
  );
  const result = spawnSync(
    process.execPath,
    [path.join(consumer, "probe.mjs")],
    {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
      timeout: 90_000,
    }
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `installed consumer failed\n${result.stdout}\n${result.stderr}`
  );
  const installed = JSON.parse(
    await fs.readFile(
      path.join(consumer, "node_modules", "obsidian-mcp-pro", "package.json"),
      "utf8"
    )
  );
  const expected = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8")
  );
  assert.equal(installed.version, expected.version);
  console.log(result.stdout.trim());
  console.log(
    JSON.stringify({
      package: installed.name,
      version: installed.version,
      node: process.version,
      platform: process.platform,
      installedDevelopmentDependencies: false,
    })
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
