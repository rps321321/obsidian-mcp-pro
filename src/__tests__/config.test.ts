import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getDailyNoteConfig, getVaultConfig } from "../config.js";

let vaultDir: string;
let configRoot: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-config-test-"));
  await fs.mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });
  delete process.env.OBSIDIAN_VAULT_NAME;
  delete process.env.OBSIDIAN_VAULT_PATH;
  process.env.APPDATA = configRoot;
  process.env.HOME = configRoot;
  process.env.XDG_CONFIG_HOME = configRoot;
  vi.spyOn(os, "homedir").mockReturnValue(configRoot);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(vaultDir, { recursive: true, force: true });
  await fs.rm(configRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function writeDailyConfig(content: string): Promise<void> {
  await fs.writeFile(path.join(vaultDir, ".obsidian", "daily-notes.json"), content, "utf-8");
}

function getTestObsidianConfigPath(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(configRoot, "obsidian", "obsidian.json");
  }
  if (platform === "darwin") {
    return path.join(
      configRoot,
      "Library",
      "Application Support",
      "obsidian",
      "obsidian.json"
    );
  }
  return path.join(configRoot, "obsidian", "obsidian.json");
}

async function writeObsidianConfig(content: string): Promise<void> {
  const configPath = getTestObsidianConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, "utf-8");
}

describe("getVaultConfig", () => {
  it("auto-detects a valid vault from a bounded Obsidian config", async () => {
    await writeObsidianConfig(JSON.stringify({
      vaults: {
        primary: {
          path: vaultDir,
        },
      },
    }));

    expect(getVaultConfig()).toEqual({
      vaultPath: path.resolve(vaultDir),
      configPath: path.join(path.resolve(vaultDir), ".obsidian"),
    });
  });

  it("ignores oversized Obsidian configs instead of auto-selecting a vault", async () => {
    await writeObsidianConfig(JSON.stringify({
      vaults: {
        primary: {
          path: vaultDir,
        },
      },
      filler: "x".repeat(2 * 1024 * 1024),
    }));

    expect(() => getVaultConfig()).toThrow(/Unable to find an Obsidian vault/);
  });
});

describe("getDailyNoteConfig", () => {
  it("uses defaults when daily-notes.json exceeds the size cap", async () => {
    await writeDailyConfig(JSON.stringify({
      folder: "daily",
      format: "YYYY-MM-DD",
      filler: "x".repeat(70 * 1024),
    }));

    await expect(getDailyNoteConfig(vaultDir)).resolves.toEqual({
      folder: "",
      format: "YYYY-MM-DD",
    });
  });

  it("ignores overlong daily-note config fields", async () => {
    await writeDailyConfig(JSON.stringify({
      folder: "a".repeat(501),
      format: "Y".repeat(501),
      template: "t".repeat(501),
    }));

    await expect(getDailyNoteConfig(vaultDir)).resolves.toEqual({
      folder: "",
      format: "YYYY-MM-DD",
    });
  });

  it("normalizes dot segments in daily-note folder config", async () => {
    await writeDailyConfig(JSON.stringify({
      folder: "./daily/../journal/./",
      format: "YYYY-MM-DD",
    }));

    const config = await getDailyNoteConfig(vaultDir);
    expect(config.folder).toBe("journal");
  });

  it("does not turn above-root daily-note folders into vault-root access", async () => {
    await writeDailyConfig(JSON.stringify({
      folder: "daily/../../outside",
      format: "YYYY-MM-DD",
    }));

    const config = await getDailyNoteConfig(vaultDir);
    expect(config.folder).toBe("daily/../../outside");
  });
});
