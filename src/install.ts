import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { sanitizeError } from "./lib/errors.js";

export type InstallClient = "claude" | "cursor";

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function claudeDesktopConfigPath(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("APPDATA environment variable not set");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "Claude", "claude_desktop_config.json");
}

function cursorConfigPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

function getConfigPath(client: InstallClient): string {
  return client === "cursor" ? cursorConfigPath() : claudeDesktopConfigPath();
}

function readConfig(configPath: string): McpConfigFile {
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as McpConfigFile;
  } catch (err) {
    throw new Error(
      `Existing config at ${configPath} is not valid JSON. Fix or delete it before re-running install. (${sanitizeError(err)})`,
    );
  }
}

function backupConfig(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  const backup = `${configPath}.backup-${Date.now()}`;
  fs.copyFileSync(configPath, backup);
  return backup;
}

function writeConfig(configPath: string, config: McpConfigFile): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Atomic write: write to a sibling temp file and rename. On both POSIX and
  // NTFS, rename-over-existing is atomic, so a concurrent reader (Claude
  // Desktop) never observes a truncated or half-written config.
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(tmp, payload, "utf-8");
  try {
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export interface InstallOptions {
  client: InstallClient;
  vaultPath?: string;
  vaultName?: string;
  serverName?: string;
}

export function runInstall(options: InstallOptions): void {
  const client = options.client;
  const serverName = options.serverName ?? "obsidian";
  const configPath = getConfigPath(client);

  console.log(`Installing obsidian-mcp-pro into ${client} config:`);
  console.log(`  ${configPath}`);

  const config = readConfig(configPath);
  const servers = (config.mcpServers ??= {});

  if (servers[serverName]) {
    console.log(`\nNote: replacing existing "${serverName}" server entry.`);
  }

  const env: Record<string, string> = {};
  if (options.vaultPath) {
    env.OBSIDIAN_VAULT_PATH = path.resolve(options.vaultPath);
  }
  if (options.vaultName) {
    // `vaultName` lands in a JSON env var consumed by Claude Desktop /
    // Cursor. The CLI usage path is safe, but `runInstall` is also a
    // public API — programmatic callers passing untrusted input could
    // smuggle null bytes or newlines that corrupt downstream env or
    // process-spawn handling. Reject any control character.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(options.vaultName)) {
      throw new Error("vaultName contains control characters; refusing to write");
    }
    env.OBSIDIAN_VAULT_NAME = options.vaultName;
  }

  const entry: McpServerEntry = {
    command: "npx",
    args: ["-y", "obsidian-mcp-pro"],
  };
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }

  servers[serverName] = entry;

  const backup = backupConfig(configPath);
  try {
    writeConfig(configPath, config);
  } catch (err) {
    // Surface the backup path so the user can recover after a failed
    // write. Without this hint, the user gets a generic error and has to
    // hunt for the .bak.<timestamp> file themselves.
    if (backup) {
      console.error(`\nWrite failed. Your previous config is preserved at: ${backup}`);
    }
    throw err;
  }

  console.log(`\n✓ Installed successfully.`);
  if (backup) console.log(`  Previous config backed up to: ${backup}`);
  console.log(`\nNext steps:`);
  if (client === "claude") {
    console.log(`  1. Fully quit Claude Desktop (not just close the window).`);
    console.log(`  2. Reopen Claude Desktop — the "obsidian" tools will appear.`);
  } else {
    console.log(`  1. Restart Cursor.`);
    console.log(`  2. The "obsidian" MCP server will appear in Cursor settings.`);
  }
  if (!options.vaultPath && !options.vaultName) {
    console.log(
      `\nVault auto-detection is enabled. To pin a specific vault, re-run with:`,
    );
    console.log(`  npx obsidian-mcp-pro install --vault /path/to/vault`);
  }
}
