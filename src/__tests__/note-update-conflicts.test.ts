import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { appendToNote, prependToNote, updateNote } from "../lib/vault.js";
import { configureLogger } from "../lib/logger.js";
import { createTestEnv, isError, textContent } from "./handlers/harness.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "note-update-conflict-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  configureLogger({ level: "info", format: "text", mcpServer: null });
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("note update conflicts", () => {
  it("preserves a separate process's edit during an asynchronous transform", async () => {
    const note = path.join(vaultDir, "note.md");
    await fs.writeFile(note, "base");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const update = updateNote(vaultDir, "note.md", async (existing) => {
      entered.resolve();
      await resume.promise;
      return existing + "\nMCP edit";
    });
    await entered.promise;
    const writer = spawnSync(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'external edit')",
        note,
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    resume.resolve();
    await expect(update).rejects.toThrow(/changed.*retry/i);
    expect(writer.error).toBeUndefined();
    expect(writer.status).toBe(0);
    await expect(fs.readFile(note, "utf8")).resolves.toBe("external edit");
    expect(await fs.readdir(vaultDir)).toEqual(["note.md"]);
  });

  it("detects a replacement even when its content and timestamps match", async () => {
    const note = path.join(vaultDir, "note.md");
    await fs.writeFile(note, "base");
    await expect(
      updateNote(vaultDir, "note.md", async () => {
        const before = await fs.stat(note);
        const replacement = path.join(vaultDir, "replacement.md");
        await fs.writeFile(replacement, "base");
        await fs.utimes(replacement, before.atime, before.mtime);
        await fs.rename(replacement, note);
        return "MCP edit";
      })
    ).rejects.toThrow(/changed.*retry/i);
    await expect(fs.readFile(note, "utf8")).resolves.toBe("base");
  });

  it("does not recreate a note deleted during its transform", async () => {
    const note = path.join(vaultDir, "note.md");
    await fs.writeFile(note, "base");
    await expect(
      updateNote(vaultDir, "note.md", async () => {
        await fs.unlink(note);
        return "MCP edit";
      })
    ).rejects.toThrow(/changed.*retry/i);
    expect(await fs.readdir(vaultDir)).toEqual([]);
  });

  it.each(["update", "append", "prepend"] as const)(
    "preserves an edit while %s stages its replacement",
    async (operation) => {
      const note = path.join(vaultDir, "note.md");
      await fs.writeFile(note, "base");
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (String(args[0]).endsWith(".tmp"))
          await writeFile(note, "external edit");
      });
      const operations = {
        update: () => updateNote(vaultDir, "note.md", () => "MCP edit"),
        append: () => appendToNote(vaultDir, "note.md", "MCP edit"),
        prepend: () => prependToNote(vaultDir, "note.md", "MCP edit"),
      };
      await expect(operations[operation]()).rejects.toThrow(/changed.*retry/i);
      await expect(fs.readFile(note, "utf8")).resolves.toBe("external edit");
      expect(await fs.readdir(vaultDir)).toEqual(["note.md"]);
    }
  );

  it.skipIf(process.platform !== "win32")(
    "checks again after a transient rename failure",
    async () => {
      const note = path.join(vaultDir, "note.md");
      await fs.writeFile(note, "base");
      const rename = fs.rename.bind(fs);
      let attempts = 0;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        attempts++;
        if (attempts === 1) {
          await fs.writeFile(note, "external edit");
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        await rename(...args);
      });
      await expect(
        appendToNote(vaultDir, "note.md", "MCP edit")
      ).rejects.toThrow(/changed.*retry/i);
      expect(attempts).toBe(1);
      await expect(fs.readFile(note, "utf8")).resolves.toBe("external edit");
    }
  );

  it("leaves no-op transforms write-free despite an external edit", async () => {
    const note = path.join(vaultDir, "note.md");
    await fs.writeFile(note, "base");
    const originalWrite = fs.writeFile.bind(fs);
    const stagedWrites = vi.spyOn(fs, "writeFile");
    await updateNote(vaultDir, "note.md", async (existing) => {
      await originalWrite(note, "external edit");
      return existing;
    });
    expect(stagedWrites).not.toHaveBeenCalled();
    await expect(fs.readFile(note, "utf8")).resolves.toBe("external edit");
  });

  it("returns a safe MCP conflict error and preserves the external content", async () => {
    const env = await createTestEnv({ skipFixtures: true });
    try {
      const note = path.join(env.vaultDir, "note.md");
      await fs.writeFile(note, "PRIVATE_BASE");
      configureLogger({ level: "error", format: "json", mcpServer: null });
      const logs: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        logs.push(String(chunk));
        return true;
      });
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (String(args[0]).endsWith(".tmp"))
          await writeFile(note, "PRIVATE_EXTERNAL");
      });
      const result = await env.client.callTool({
        name: "append_to_note",
        arguments: { path: "note.md", content: "MCP edit" },
      });
      expect(isError(result)).toBe(true);
      expect(textContent(result)).toMatch(/changed.*retry/i);
      expect(textContent(result)).not.toMatch(/PRIVATE_BASE|PRIVATE_EXTERNAL/);
      expect(textContent(result)).not.toContain(env.vaultDir);
      expect(logs.join("")).toContain("append_to_note failed");
      expect(logs.join("")).not.toMatch(/PRIVATE_BASE|PRIVATE_EXTERNAL/);
      expect(logs.join("")).not.toContain(env.vaultDir);
      await expect(fs.readFile(note, "utf8")).resolves.toBe("PRIVATE_EXTERNAL");
    } finally {
      await env.cleanup();
    }
  });
});
