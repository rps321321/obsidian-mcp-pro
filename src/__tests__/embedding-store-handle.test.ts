import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  openEmbeddingStore,
  hashText,
} from "../lib/embedding-store-handle.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "embedding-handle-"));
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("EmbeddingStore handle", () => {
  it("starts empty and exposes production stats/isEmpty APIs", async () => {
    const store = openEmbeddingStore(vaultDir);
    await store.load();

    expect(store.isEmpty()).toBe(true);
    expect(store.stats()).toEqual({
      totalChunks: 0,
      totalNotes: 0,
      providerId: null,
      model: null,
      dimension: null,
    });
  });

  it("owns mutable state per handle instead of sharing an ambient vault registry", async () => {
    const first = openEmbeddingStore(vaultDir);
    const second = openEmbeddingStore(vaultDir);
    await Promise.all([first.load(), second.load()]);

    first.setNoteChunks(
      "a.md",
      hashText("alpha"),
      [
        {
          notePath: "a.md",
          chunkIndex: 1,
          headingPath: [],
          text: "alpha",
          hash: "chunk-a",
          vector: [1, 0],
        },
      ],
      "fixture",
      "model"
    );

    expect(first.isEmpty()).toBe(false);
    expect(first.stats().totalChunks).toBe(1);
    expect(second.isEmpty()).toBe(true);
    expect(second.stats().totalChunks).toBe(0);
  });

  it("persists through one handle and rehydrates through a new handle", async () => {
    const writer = openEmbeddingStore(vaultDir);
    await writer.load();
    writer.setNoteChunks(
      "a.md",
      hashText("alpha"),
      [
        {
          notePath: "a.md",
          chunkIndex: 1,
          headingPath: ["A"],
          text: "alpha",
          hash: "chunk-a",
          vector: [1, 0, 0],
        },
      ],
      "fixture",
      "model"
    );
    await writer.save();

    const reader = openEmbeddingStore(vaultDir);
    await Promise.all([reader.load(), reader.load()]);

    expect(reader.stats()).toEqual({
      totalChunks: 1,
      totalNotes: 1,
      providerId: "fixture",
      model: "model",
      dimension: 3,
    });
    expect(reader.getNoteEmbeddings("a.md")[0]?.text).toBe("alpha");

    await reader.clear({ removeSnapshot: true });
  });

  it("supports a per-handle persistence cap without module-global test state", async () => {
    const tiny = openEmbeddingStore(vaultDir, { maxEmbeddingBytes: 100 });
    await tiny.load();
    tiny.setNoteChunks(
      "big.md",
      "h",
      [
        {
          notePath: "big.md",
          chunkIndex: 1,
          headingPath: [],
          text: "x",
          hash: "chunk",
          vector: Array.from({ length: 64 }, (_, index) => index / 64),
        },
      ],
      "fixture",
      "model"
    );
    await tiny.save();

    const snapshot = path.join(
      vaultDir,
      ".obsidian",
      "cache",
      "mcp-pro-embeddings.json"
    );
    await expect(fs.access(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
