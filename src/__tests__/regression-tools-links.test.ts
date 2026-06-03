import fs from "fs/promises";
import path from "path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";

// Regression coverage for three link-tool findings:
//
//   - H5: find_broken_links was sequential. Every note read awaited the
//         previous one, so a 5k-note vault that search_notes processed in
//         seconds took an order of magnitude longer here. Fix: route reads
//         through readAllCached, matching the search_notes pattern.
//
//   - H6: get_backlinks dropped alias resolution in its display pass. The
//         filter callback called resolveWikilink WITHOUT the aliasMap that
//         was used to build the graph, so alias-only links slipped into the
//         backlink set during build but produced an empty line/context in
//         the rendered output.
//
//   - M11: get_outlinks bypassed the link-graph cache and rebuilt allNotes +
//          re-read the source note from scratch on every call. Worse, it
//          omitted the aliasMap, so alias-only outlinks were reported as
//          broken even when they resolved cleanly via get_backlinks from the
//          other side.

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

// --------------------------------------------------------------------------
// H5: find_broken_links should fan out note reads instead of serializing them
// --------------------------------------------------------------------------

/** Build a 50-note vault with one broken link to exercise the scan loop
 *  without spending the whole test budget on I/O. */
function makeBroadVault(noteCount: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < noteCount; i++) {
    const padded = String(i).padStart(3, "0");
    // A mix of valid and (one) broken links keeps both code paths warm.
    const target = i === 0 ? "missing-target" : `note-${String((i - 1) % noteCount).padStart(3, "0")}`;
    files[`note-${padded}.md`] = `# Note ${padded}\n\nReference [[${target}]] for context.\nbody-keyword-${padded}\n`;
  }
  return files;
}

describe("H5: find_broken_links uses bounded parallelism, not a serial loop", () => {
  it("performs overlapping note reads on a cold 50-note vault", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: makeBroadVault(50),
    });

    let activeReads = 0;
    let maxActiveReads = 0;
    let noteReads = 0;
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>) => {
        const fileArg = args[0];
        const filePath = typeof fileArg === "string" ? fileArg : undefined;
        const isVaultNote = filePath !== undefined
          && filePath.startsWith(env.vaultDir + path.sep)
          && filePath.endsWith(".md");

        if (!isVaultNote) {
          return originalReadFile(...args);
        }

        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        noteReads++;
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return await originalReadFile(...args);
        } finally {
          activeReads--;
        }
      },
    );

    try {
      const brokenResult = await env.client.callTool({
        name: "find_broken_links",
        arguments: {},
      });

      expect(isError(brokenResult)).toBe(false);
      expect(textContent(brokenResult)).toContain("missing-target");
      expect(noteReads).toBe(50);
      expect(maxActiveReads).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
    }
  });
});

// --------------------------------------------------------------------------
// H6 + M11: alias-resolved links must report line+context in get_backlinks
// AND must resolve cleanly in get_outlinks (the two sides of the same link).
// --------------------------------------------------------------------------

/**
 * Two-note alias fixture:
 *   - aliased.md declares an alias "My Project" in its frontmatter.
 *   - linker.md writes `[[My Project]]` (line 3) — a pure alias reference,
 *     not a basename match. Without aliasMap, resolveWikilink returns null.
 */
const ALIAS_FIXTURE: Record<string, string> = {
  "aliased.md": `---
aliases:
  - My Project
---
# Aliased Note

Body content for the aliased note.
`,
  "linker.md": `# Linker

I reference [[My Project]] in this note.
Also another mention: [[My Project|alt display]].
`,
};

describe("H6: get_backlinks resolves alias references with line + context", () => {
  it("returns a non-zero line number and non-empty context for alias-resolved backlinks", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: ALIAS_FIXTURE,
    });

    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "aliased.md" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);

    // The source must show up, with a real line number and context arrow.
    expect(text).toContain("linker.md");
    // Line 3 contains `[[My Project]]` (counting the `# Linker` heading on
    // line 1, blank line 2). If aliasMap is dropped, the display pass
    // resolves to null, relevantLinks is empty, and the source is rendered
    // as `- linker.md` with no `:N → context` suffix.
    expect(text).toMatch(/linker\.md:\d+/);
    expect(text).toMatch(/→ I reference \[\[My Project\]\]/);
  });
});

describe("M11: get_outlinks resolves alias references via the link graph", () => {
  it("classifies alias-only outlinks as valid (matching get_backlinks)", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: ALIAS_FIXTURE,
    });

    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "linker.md" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);

    // Two outgoing wikilinks (`[[My Project]]` and `[[My Project|alt]]`),
    // both resolving via the alias map to `aliased.md`. Pre-fix, both were
    // counted as broken because get_outlinks called resolveWikilink without
    // the aliasMap.
    expect(text).toMatch(/2 valid, 0 broken/);
    expect(text).toContain("aliased.md");
    // The valid-links section must contain the alias text the user wrote,
    // not the resolved filename, so they can find it in the source note.
    expect(text).toContain("[[My Project]]");
  });

  it("agrees with get_backlinks on the source -> target mapping for an alias", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: ALIAS_FIXTURE,
    });

    const outlinks = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "linker.md" },
    });
    const backlinks = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "aliased.md" },
    });

    // Both sides must reflect the same edge: outlinks reports the resolved
    // target, backlinks reports the source.
    expect(textContent(outlinks)).toContain("aliased.md");
    expect(textContent(backlinks)).toContain("linker.md");
  });
});
