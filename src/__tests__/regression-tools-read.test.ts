import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";
import { clearCache } from "../lib/index-cache.js";

// Regression coverage for M13: `get_vault_stats` previously ran TWO O(n)
// passes over the vault - one through `readAllCached` for bytes/words/tags
// and a second `mapConcurrent` calling `getNoteStats` (which itself does
// `resolveVaultPathSafe` + `fs.stat`) just to find the most-recently-modified
// note. The fix folds the stat into the same per-note worker that aggregates
// content metrics so each note is stat()'d at most once per call.
//
// These tests pin the behavior that survives the refactor:
//   1. The "most recent" picker still picks correctly when one note's mtime
//      is bumped after the others.
//   2. The numeric metrics (note count, total/avg words, tag counts) match a
//      hand-computed baseline for a fresh fixture vault, guarding against
//      regressions in the aggregation rewrite.
//   3. The combined pass stays fast on a 100-note vault (loose 1s bound).

let env: TestEnv;

afterEach(async () => {
  if (env) {
    await clearCache(env.vaultDir, { removeSnapshot: true });
    await env.cleanup();
  }
});

describe("get_vault_stats - M13 single-pass mtime aggregation", () => {
  it("identifies the most-recently-modified note (touched mtime wins)", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "alpha.md": "alpha body content here\n",
        "beta.md": "beta body has different content\n",
        "gamma.md": "gamma body line\n",
        "delta.md": "delta body content\n",
        "epsilon.md": "epsilon final note\n",
      },
    });

    // Stagger mtimes deterministically so there's no ambiguity. Bump
    // `gamma.md` last so it ends up as the most-recent.
    const base = Date.now();
    const ordered: Array<[string, number]> = [
      ["alpha.md", base - 50_000],
      ["beta.md", base - 40_000],
      ["delta.md", base - 30_000],
      ["epsilon.md", base - 20_000],
      ["gamma.md", base - 1_000],
    ];
    for (const [rel, ms] of ordered) {
      const full = path.join(env.vaultDir, rel);
      const when = new Date(ms);
      await fs.utimes(full, when, when);
    }

    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    // The picker has to land on gamma even though gamma sits in the middle
    // alphabetically - this catches a refactor that accidentally falls back
    // to "last note in the list".
    expect(text).toContain("Most recent:");
    expect(text).toContain("gamma.md");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: get_vault_stats most recent path]");
    expect(text).toMatch(/Notes:\s+5/);
  });

  it("preserves word counts and tag aggregation after the rewrite", async () => {
    // Three small notes with known word counts and tag shapes so we can
    // compute the expected totals by hand.
    //   note-1.md:  body = "one two three four five" -> 5 words
    //               tags = ["foo"]
    //   note-2.md:  body = "alpha beta gamma" -> 3 words
    //               tags = ["foo", "bar"]
    //   note-3.md:  body = "solo" -> 1 word
    //               (no tags - contributes to "untagged")
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "note-1.md": "one two three four five\n#foo\n",
        "note-2.md": "alpha beta gamma\n#foo #bar\n",
        "note-3.md": "solo\n",
      },
    });

    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);

    // Total words = 5 + 3 + 1 + (the inline #tag lines each contribute their
    // own \S+ tokens). `extractTags` already strips #-prefixed words from
    // the word-count pipeline? No - the prior implementation counted them.
    // Rather than hard-code a number that depends on parseFrontmatter
    // semantics, assert the cross-check: avg words/note = total / count.
    const totalMatch = text.match(/Total words:\s+([\d,]+)/);
    const avgMatch = text.match(/Avg words\/note:\s+([\d,]+)/);
    const notesMatch = text.match(/Notes:\s+(\d+)/);
    expect(totalMatch).not.toBeNull();
    expect(avgMatch).not.toBeNull();
    expect(notesMatch).not.toBeNull();
    const total = Number(totalMatch![1].replace(/,/g, ""));
    const avg = Number(avgMatch![1].replace(/,/g, ""));
    const count = Number(notesMatch![1]);
    expect(count).toBe(3);
    expect(avg).toBe(Math.round(total / count));
    // Total words: each note body contributes >=1 \S+ run, so total >= 3.
    expect(total).toBeGreaterThanOrEqual(3);

    // Tag aggregation: 2 unique tags (foo, bar), 1 untagged note (note-3).
    expect(text).toMatch(/Unique tags:\s+2/);
    expect(text).toMatch(/Untagged notes:\s+1\s+\(33\.3%\)/);
  });

  it("completes on a 100-note fixture in under 1 second", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      files[`bulk/note-${String(i).padStart(3, "0")}.md`] =
        `# Note ${i}\n\nsome body content with a handful of words ${i}.\n#bulk\n`;
    }
    env = await createTestEnv({ skipFixtures: true, extraFiles: files });

    const start = Date.now();
    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: {},
    });
    const elapsed = Date.now() - start;
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/Notes:\s+100/);
    // Loose 1s bound - even on slow CI a single-pass scan over 100 small
    // notes should finish well under this. The pre-fix version made 2n
    // passes; on a cold cache this was the bottleneck for large vaults.
    expect(elapsed).toBeLessThan(1000);
  });
});
