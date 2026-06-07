import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { VaultConfig, DailyNoteConfig } from "./types.js";
import { log } from "./lib/logger.js";
import { openVaultInternalFileForRead } from "./lib/vault.js";

const DAILY_NOTES_CONFIG_REL_PATH = ".obsidian/daily-notes.json";
const MAX_DAILY_NOTES_CONFIG_BYTES = 64 * 1024;
const MAX_DAILY_NOTES_CONFIG_FIELD_CHARS = 500;

interface ObsidianVaultEntry {
  path: string;
  ts?: number;
  open?: boolean;
}

interface ObsidianConfig {
  vaults: Record<string, ObsidianVaultEntry>;
}

function getObsidianConfigPath(): string {
  const platform = os.platform();

  if (platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error("APPDATA environment variable is not set");
    }
    return path.join(appData, "obsidian", "obsidian.json");
  }

  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "obsidian",
      "obsidian.json"
    );
  }

  // Linux and other Unix-like systems
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "obsidian", "obsidian.json");
}

function isObsidianConfig(value: unknown): value is ObsidianConfig {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!obj.vaults || typeof obj.vaults !== "object") return false;

  const vaults = obj.vaults as Record<string, unknown>;
  for (const [, entry] of Object.entries(vaults)) {
    if (entry === null || typeof entry !== "object") return false;
    const vault = entry as Record<string, unknown>;
    if (typeof vault.path !== "string") return false;
  }

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedDailyConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_DAILY_NOTES_CONFIG_FIELD_CHARS) return undefined;
  if (value.includes("\0")) return undefined;
  return value;
}

function isValidVaultPath(vaultPath: string): boolean {
  try {
    const obsidianDir = path.join(vaultPath, ".obsidian");
    return (
      fs.existsSync(vaultPath) &&
      fs.statSync(vaultPath).isDirectory() &&
      fs.existsSync(obsidianDir) &&
      fs.statSync(obsidianDir).isDirectory()
    );
  } catch {
    return false;
  }
}

function resolveVaultFromEnv(): string | null {
  const envPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!envPath) {
    return null;
  }

  const resolved = path.resolve(envPath);
  if (!isValidVaultPath(resolved)) {
    // The logger redacts the path before writing to stderr or forwarding to
    // MCP clients, so this stays useful without leaking host layout.
    log.warn("OBSIDIAN_VAULT_PATH is not a valid vault (missing .obsidian dir)", {
      vaultPath: resolved,
    });
    return null;
  }

  return resolved;
}

function resolveVaultFromObsidianConfig(): string | null {
  let configPath: string;
  try {
    configPath = getObsidianConfigPath();
  } catch (err) {
    log.warn("Failed to determine Obsidian config path", { err: err as Error });
    return null;
  }

  if (!fs.existsSync(configPath)) {
    log.warn("Obsidian config not found", { configPath });
    return null;
  }

  let config: ObsidianConfig;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isObsidianConfig(parsed)) {
      log.warn("Obsidian config failed runtime validation (missing or malformed vaults)", {
        configPath,
      });
      return null;
    }
    config = parsed;
  } catch (err) {
    log.warn("Failed to parse Obsidian config", { configPath, err: err as Error });
    return null;
  }

  if (Object.keys(config.vaults).length === 0) {
    log.warn("No vaults found in Obsidian config");
    return null;
  }

  const vaultEntries = Object.values(config.vaults);

  const desiredName = process.env.OBSIDIAN_VAULT_NAME;

  if (desiredName) {
    const matched = vaultEntries.find((entry) => {
      const vaultName = path.basename(entry.path);
      return vaultName === desiredName;
    });

    if (matched) {
      const resolved = path.resolve(matched.path);
      if (isValidVaultPath(resolved)) {
        return resolved;
      }
      log.warn("Vault listed in Obsidian config but path is not a valid vault", {
        vaultName: desiredName,
        vaultPath: resolved,
      });
      return null;
    }

    log.warn("OBSIDIAN_VAULT_NAME has no matching vault in Obsidian config", {
      vaultName: desiredName,
    });
    return null;
  }

  // No name specified — try the first valid vault
  for (const entry of vaultEntries) {
    const resolved = path.resolve(entry.path);
    if (isValidVaultPath(resolved)) {
      if (vaultEntries.length > 1) {
        log.info("Multiple vaults found; defaulting to first valid one. Set OBSIDIAN_VAULT_NAME to select a specific vault.", {
          selected: path.basename(resolved),
        });
      }
      return resolved;
    }
  }

  log.warn("No valid vault paths found in Obsidian config");
  return null;
}

export function getVaultConfig(): VaultConfig {
  // Priority 1: environment variable
  const envVault = resolveVaultFromEnv();
  if (envVault) {
    return {
      vaultPath: envVault,
      configPath: path.join(envVault, ".obsidian"),
    };
  }

  // Priority 2: auto-detect from Obsidian's global config
  const detectedVault = resolveVaultFromObsidianConfig();
  if (detectedVault) {
    return {
      vaultPath: detectedVault,
      configPath: path.join(detectedVault, ".obsidian"),
    };
  }

  throw new Error(
    "Unable to find an Obsidian vault. Set OBSIDIAN_VAULT_PATH environment variable or ensure Obsidian is installed with at least one vault configured."
  );
}

export async function getDailyNoteConfig(vaultPath?: string): Promise<DailyNoteConfig> {
  const defaults: DailyNoteConfig = {
    folder: "",
    format: "YYYY-MM-DD",
  };

  const resolvedVaultPath = vaultPath ?? getVaultConfig().vaultPath;
  let dailyNotesConfigPath = "";
  let raw: string;
  try {
    const opened = await openVaultInternalFileForRead(
      resolvedVaultPath,
      DAILY_NOTES_CONFIG_REL_PATH,
    );
    dailyNotesConfigPath = opened.fullPath;
    const stats = opened.stats;
    if (stats.size > MAX_DAILY_NOTES_CONFIG_BYTES) {
      await opened.handle.close();
      log.warn("Daily notes config exceeds size cap; using defaults", {
        bytes: stats.size,
        max: MAX_DAILY_NOTES_CONFIG_BYTES,
      });
      return defaults;
    }
    try {
      raw = await opened.handle.readFile("utf-8");
    } finally {
      await opened.handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    log.warn("Failed to read daily notes config", {
      configPath: dailyNotesConfigPath,
      err: err as Error,
    });
    return defaults;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return defaults;
    const folder = boundedDailyConfigString(parsed.folder);
    const format = boundedDailyConfigString(parsed.format);
    const template = boundedDailyConfigString(parsed.template);
    return {
      folder: folder ?? defaults.folder,
      format: format ?? defaults.format,
      template,
    };
  } catch (err) {
    log.warn("Failed to parse daily notes config", {
      configPath: dailyNotesConfigPath,
      err: err as Error,
    });
    return defaults;
  }
}
