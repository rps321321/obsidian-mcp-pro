import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendToNote, updateNote, writeNote } from "../lib/vault.js";
import { atomicWriteFile } from "../lib/vault-fs.js";

let vaultDir: string;
let originalUmask: number;

describe.skipIf(process.platform === "win32")(
  "POSIX atomic replacement modes",
  () => {
    beforeEach(async (context) => {
      originalUmask = process.umask(0o022);
      vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-mode-"));
      const probe = path.join(vaultDir, "probe");
      await fs.writeFile(probe, "");
      await fs.chmod(probe, 0o600);
      const supported = ((await fs.stat(probe)).mode & 0o777) === 0o600;
      await fs.unlink(probe);
      if (!supported) context.skip("Filesystem does not enforce POSIX modes");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      process.umask(originalUmask);
      await fs.rm(vaultDir, { recursive: true, force: true });
    });

    it("preserves a 0600 note during an ordinary append under umask 022", async () => {
      const note = path.join(vaultDir, "private.md");
      await fs.writeFile(note, "private");
      await fs.chmod(note, 0o600);

      await appendToNote(vaultDir, "private.md", "appended");

      expect((await fs.stat(note)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(note, "utf8")).toBe("private\nappended");
    });

    it("creates the staging file with restricted permissions before note bytes are written", async () => {
      const note = path.join(vaultDir, "private.md");
      await fs.writeFile(note, "private");
      await fs.chmod(note, 0o600);
      const writeFile = fs.writeFile.bind(fs);
      const observed: number[] = [];
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (String(args[0]).endsWith(".tmp")) {
          await writeFile(args[0], "", args[2]);
          observed.push((await fs.stat(String(args[0]))).mode & 0o777);
          await writeFile(args[0], args[1]);
        } else {
          await writeFile(...args);
        }
      });

      await appendToNote(vaultDir, "private.md", "appended");

      expect(observed).toEqual([0o600]);
    });

    it.each([0o400, 0o600, 0o640, 0o660, 0o700])(
      "preserves existing mode %i independently of a stricter umask",
      async (mode) => {
        const note = path.join(vaultDir, "note.md");
        await fs.writeFile(note, "old");
        await fs.chmod(note, mode);
        process.umask(0o077);

        await atomicWriteFile(note, "replacement");

        expect((await fs.stat(note)).mode & 0o777).toBe(mode);
        expect(await fs.readFile(note, "utf8")).toBe("replacement");
        expect(await fs.readdir(vaultDir)).toEqual(["note.md"]);
      }
    );

    it.each([0o022, 0o077, 0o002])(
      "keeps new-note creation permissions under umask %i",
      async (mask) => {
        process.umask(mask);
        await writeNote(vaultDir, "created.md", "created", { exclusive: true });
        await atomicWriteFile(path.join(vaultDir, "direct.md"), "direct");

        expect(
          (await fs.stat(path.join(vaultDir, "created.md"))).mode & 0o777
        ).toBe(0o666 & ~mask);
        expect(
          (await fs.stat(path.join(vaultDir, "direct.md"))).mode & 0o777
        ).toBe(0o666 & ~mask);
      }
    );

    it("preserves the target and removes staging after a permission failure", async () => {
      const note = path.join(vaultDir, "note.md");
      await fs.writeFile(note, "original");
      await fs.chmod(note, 0o600);
      vi.spyOn(fs, "chmod").mockRejectedValueOnce(
        new Error("simulated staging chmod failure")
      );

      await expect(
        appendToNote(vaultDir, "note.md", "appended")
      ).rejects.toThrow("simulated staging chmod failure");

      expect(await fs.readFile(note, "utf8")).toBe("original");
      expect((await fs.stat(note)).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(vaultDir)).toEqual(["note.md"]);
    });
    it("rejects a stale permission snapshot when timestamps and content match", async () => {
      const note = path.join(vaultDir, "note.md");
      await fs.writeFile(note, "original");
      await fs.chmod(note, 0o640);
      const expectedStats = await fs.stat(note);
      expectedStats.mode = (expectedStats.mode & ~0o7777) | 0o600;

      await expect(
        atomicWriteFile(note, "replacement", {
          content: Buffer.from("original"),
          stats: expectedStats,
        })
      ).rejects.toThrow(/changed.*retry/i);

      expect(await fs.readFile(note, "utf8")).toBe("original");
      expect((await fs.stat(note)).mode & 0o777).toBe(0o640);
      expect(await fs.readdir(vaultDir)).toEqual(["note.md"]);
    });

    it("preserves an external permission change instead of replacing that version", async () => {
      const note = path.join(vaultDir, "note.md");
      await fs.writeFile(note, "original");
      await fs.chmod(note, 0o600);

      await expect(
        updateNote(vaultDir, "note.md", async () => {
          await fs.chmod(note, 0o640);
          return "replacement";
        })
      ).rejects.toThrow(/changed.*retry/i);

      expect(await fs.readFile(note, "utf8")).toBe("original");
      expect((await fs.stat(note)).mode & 0o777).toBe(0o640);
      expect(await fs.readdir(vaultDir)).toEqual(["note.md"]);
    });
  }
);
