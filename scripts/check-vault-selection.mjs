import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../build/index.js", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-selection-cli-"));
try {
  const alternate = path.join(root, "alternate");
  fs.mkdirSync(path.join(alternate, ".obsidian"), { recursive: true });
  const configDir = process.platform === "darwin"
    ? path.join(root, "Library", "Application Support", "obsidian")
    : path.join(root, "obsidian");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "obsidian.json"), JSON.stringify({
    vaults: { alternate: { path: alternate } },
  }));
  const result = spawnSync(process.execPath, [cli, "serve"], {
    env: {
      ...process.env,
      APPDATA: root,
      HOME: root,
      XDG_CONFIG_HOME: root,
      OBSIDIAN_VAULT_PATH: path.join(root, "missing-selected"),
      OBSIDIAN_VAULT_NAME: "",
      MCP_HTTP_TOKEN: "",
      LOG_LEVEL: "info",
      LOG_FORMAT: "json",
    },
    input: "",
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OBSIDIAN_VAULT_PATH/);
  assert.doesNotMatch(result.stderr, /Vault not configured|Vault configured|Server started|connected/i);
  console.log("PASS: built CLI rejects invalid explicit selection before serving an alternate vault");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
