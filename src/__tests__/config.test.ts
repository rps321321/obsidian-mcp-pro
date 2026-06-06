import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getDailyNoteConfig } from "../config.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  await fs.mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function writeDailyConfig(content: string): Promise<void> {
  await fs.writeFile(path.join(vaultDir, ".obsidian", "daily-notes.json"), content, "utf-8");
}

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
});
