import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { VaultConfig, DailyNoteConfig } from "./types.js";
import { log } from "./lib/logger.js";

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
    // Log the configured path (not sanitized) because this is an operator-
    // facing diagnostic — they already know the path, and hiding it would
    // make the error useless. This never goes into a tool response.
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
    config = JSON.parse(raw) as ObsidianConfig;
  } catch (err) {
    log.warn("Failed to parse Obsidian config", { configPath, err: err as Error });
    return null;
  }

  if (!config.vaults || typeof config.vaults !== "object") {
    log.warn("No vaults found in Obsidian config");
    return null;
  }

  const vaultEntries = Object.values(config.vaults);
  if (vaultEntries.length === 0) {
    log.warn("Obsidian config contains no vault entries");
    return null;
  }

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
  const dailyNotesConfigPath = path.join(
    resolvedVaultPath,
    ".obsidian",
    "daily-notes.json"
  );

  let raw: string;
  try {
    raw = await fsp.readFile(dailyNotesConfigPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    log.warn("Failed to read daily notes config", {
      configPath: dailyNotesConfigPath,
      err: err as Error,
    });
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      folder: typeof parsed.folder === "string" ? parsed.folder : defaults.folder,
      format: typeof parsed.format === "string" ? parsed.format : defaults.format,
      template:
        typeof parsed.template === "string" ? parsed.template : undefined,
    };
  } catch (err) {
    log.warn("Failed to parse daily notes config", {
      configPath: dailyNotesConfigPath,
      err: err as Error,
    });
    return defaults;
  }
}
