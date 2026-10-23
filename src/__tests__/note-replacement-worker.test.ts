import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { replaceNoteText } from "../lib/note-replacement.js";
import { hasUnsafeRepeatedGroup } from "../tools/sections/shared.js";
import {
  createTestEnv,
  isError,
  textContent,
  type TestEnv,
} from "./handlers/harness.js";

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("bounded note replacement", () => {
  it("terminates a costly pattern accepted by the shape guard", async () => {
    const find = "^" + "a*".repeat(10) + "b$";
    expect(hasUnsafeRepeatedGroup(find)).toBe(false);
    await expect(
      replaceNoteText({
        text: "a".repeat(80),
        find,
        replace: "x",
        regex: true,
        flags: "g",
      })
    ).rejects.toThrow(/worker budget/i);
    await expect(
      replaceNoteText({
        text: "after",
        find: "after",
        replace: "works",
        regex: true,
        flags: "g",
        expectedCount: 1,
      })
    ).resolves.toEqual({ count: 1, nextContent: "works" });
  });

  it.each([
    {
      text: "Aa\nAA",
      find: "a+",
      replace: "x",
      flags: "gi",
      count: 2,
      nextContent: "x\nx",
    },
    {
      text: "a\nb",
      find: "^.",
      replace: "x",
      flags: "gm",
      count: 2,
      nextContent: "x\nx",
    },
    {
      text: "a\nb",
      find: "a.b",
      replace: "x",
      flags: "gs",
      count: 1,
      nextContent: "x",
    },
    {
      text: "😀x",
      find: "(?=.)",
      replace: "_",
      flags: "gu",
      count: 2,
      nextContent: "_😀_x",
    },
    {
      text: "aab",
      find: "a",
      replace: "x",
      flags: "gy",
      count: 2,
      nextContent: "xxb",
    },
    {
      text: "ab",
      find: "(?<first>a)(b)",
      replace: "$2-$1-$<first>-$$-$&-$`-$'",
      flags: "g",
      count: 1,
      nextContent: "b-a-a-$-ab--",
    },
  ])(
    "preserves native regex behavior for $flags",
    async ({ count, nextContent, ...input }) => {
      await expect(
        replaceNoteText({ ...input, regex: true, expectedCount: count })
      ).resolves.toEqual({ count, nextContent });
    }
  );

  it("keeps dollar tokens literal in literal mode", async () => {
    await expect(
      replaceNoteText({
        text: "a.b a.b",
        find: "a.b",
        replace: "$&-$1-$$",
        regex: false,
        flags: "g",
      })
    ).resolves.toEqual({ count: 2, nextContent: "$&-$1-$$ $&-$1-$$" });
  });

  it("rejects a count mismatch before replacing", async () => {
    await expect(
      replaceNoteText({
        text: "aa",
        find: "a",
        replace: "x",
        regex: true,
        flags: "g",
        expectedCount: 1,
      })
    ).rejects.toThrow("Match-count check failed: expected 1, found 2.");
  });

  it("handles the full input size and match count", async () => {
    const result = await replaceNoteText({
      text: "a".repeat(1_000_000),
      find: "a",
      replace: "x",
      regex: true,
      flags: "g",
      expectedCount: 1_000_000,
    });
    expect(result.count).toBe(1_000_000);
    expect(result.nextContent).toBe("x".repeat(1_000_000));
  });

  it("handles a full replacement payload and five-million-byte output", async () => {
    const result = await replaceNoteText({
      text: "aaaaa",
      find: "a",
      replace: "x".repeat(1_000_000),
      regex: true,
      flags: "g",
      expectedCount: 5,
    });
    expect(result.count).toBe(5);
    expect(result.nextContent).toBe("x".repeat(5_000_000));
  });

  it("rejects excessive output before returning it to the caller", async () => {
    await expect(
      replaceNoteText({
        text: "aaaaaa",
        find: "a",
        replace: "x".repeat(1_000_000),
        regex: true,
        flags: "g",
      })
    ).rejects.toThrow(/output.*limit/i);
  });

  it("contains extreme replacement allocation failure inside the worker", async () => {
    await expect(
      replaceNoteText({
        text: "a".repeat(1_000_000),
        find: "a",
        replace: "x".repeat(1_000_000),
        regex: true,
        flags: "g",
      })
    ).rejects.toThrow(/worker failed|worker budget|output.*limit/i);
    await expect(
      replaceNoteText({
        text: "safe",
        find: "safe",
        replace: "next",
        regex: false,
        flags: "g",
      })
    ).resolves.toEqual({ count: 1, nextContent: "next" });
  });

  it("measures the output limit in UTF-8 bytes", async () => {
    await expect(
      replaceNoteText({
        text: "aaa",
        find: "a",
        replace: "é".repeat(1_000_000),
        regex: true,
        flags: "g",
      })
    ).rejects.toThrow(/output.*limit/i);
  });

  it("preserves note bytes on count and output failures", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: { "note.md": "aaaaaa" },
    });
    for (const args of [
      { replace: "x", expectedCount: 7 },
      { replace: "x".repeat(1_000_000) },
    ]) {
      const result = await env.client.callTool({
        name: "replace_in_note",
        arguments: { path: "note.md", find: "a", regex: true, ...args },
      });
      expect(isError(result)).toBe(true);
      await expect(
        fs.readFile(path.join(env.vaultDir, "note.md"), "utf8")
      ).resolves.toBe("aaaaaa");
    }
  });

  it("terminates a cancelled worker without exposing its cancellation reason", async () => {
    const controller = new AbortController();
    const pending = replaceNoteText(
      {
        text: "a".repeat(80),
        find: "^" + "a*".repeat(10) + "b$",
        replace: "x",
        regex: true,
        flags: "g",
      },
      controller.signal
    );
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toThrow(
      "Replacement cancelled. No changes written."
    );
  });

  it("honors cancellation while the completed worker terminates", async () => {
    const controller = new AbortController();
    const onWorker = (worker: Worker): void => {
      worker.once("exit", () =>
        controller.abort(new Error("PRIVATE_EXIT_REASON"))
      );
    };
    process.once("worker", onWorker);
    try {
      await expect(
        replaceNoteText(
          {
            text: "safe",
            find: "safe",
            replace: "next",
            regex: true,
            flags: "g",
          },
          controller.signal
        )
      ).rejects.toThrow("Replacement cancelled. No changes written.");
    } finally {
      process.removeListener("worker", onWorker);
    }
  });

  it("keeps other MCP reads responsive and leaves the note unchanged on timeout", async () => {
    const original = "a".repeat(80);
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: { "costly.md": original, "read.md": "other note" },
    });
    let finished = false;
    const pending = env.client
      .callTool({
        name: "replace_in_note",
        arguments: {
          path: "costly.md",
          find: "^" + "a*".repeat(10) + "b$",
          replace: "x",
          regex: true,
        },
      })
      .then((result) => {
        finished = true;
        return result;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const read = await env.client.callTool({
      name: "get_note",
      arguments: { path: "read.md" },
    });
    expect(isError(read)).toBe(false);
    expect(textContent(read)).toContain("other note");
    expect(finished).toBe(false);
    const result = await pending;
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/worker budget/i);
    await expect(
      fs.readFile(path.join(env.vaultDir, "costly.md"), "utf8")
    ).resolves.toBe(original);
    const subsequent = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "costly.md",
        find: "a",
        replace: "b",
        regex: true,
        expectedCount: 80,
      },
    });
    expect(isError(subsequent)).toBe(false);
    await expect(
      fs.readFile(path.join(env.vaultDir, "costly.md"), "utf8")
    ).resolves.toBe("b".repeat(80));
  });
});
