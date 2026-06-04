import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("read handlers — search_notes", () => {
  it("finds notes by literal content match", async () => {
    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "conclusion" },
    });
    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("note-b.md");
    expect(text).toContain("note-c.md");
  });

  it("respects case sensitivity when asked", async () => {
    const insensitive = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "CONCLUSION", caseSensitive: false },
    });
    const sensitive = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "CONCLUSION", caseSensitive: true },
    });
    expect(textContent(insensitive)).toContain("note-c.md");
    expect(textContent(sensitive)).toMatch(/No results/i);
  });

  it("honors maxResults cap", async () => {
    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "note", maxResults: 2 },
    });
    const text = textContent(result);
    // "Found N result(s)" header — cap at 2 means ≤2 distinct source notes
    const headerMatch = text.match(/Found (\d+) result/);
    expect(headerMatch).not.toBeNull();
    expect(Number(headerMatch![1])).toBeLessThanOrEqual(2);
  });

  it("restricts scan to a folder when folder= is set", async () => {
    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "Nested", folder: "nested" },
    });
    expect(textContent(result)).toContain("note-d.md");
    expect(textContent(result)).not.toContain("note-a.md");
  });

  it("returns a friendly message for zero results", async () => {
    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "absolutelyuniquephrase" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No results found/);
  });

  it("escapes control characters in the zero-result query label", async () => {
    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "missing\nphrase" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain('No results found for "missing\\nphrase"');
    expect(text).not.toContain("missing\nphrase");
  });

  it("escapes control characters in matched line snippets", async () => {
    await fs.writeFile(path.join(env.vaultDir, "dirty.md"), "needle\tvalue\n", "utf-8");

    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "needle" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("Line 1: needle\\tvalue");
    expect(text).not.toContain("needle\tvalue");
  });

  it("rejects empty query via zod validation (tool-level isError)", async () => {
    const result = await env.client.callTool({
      name: "search_notes",
      arguments: { query: "" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/validation|too_small|query/i);
  });
});

describe("read handlers — get_note", () => {
  it("renders frontmatter block + tags + body", async () => {
    const result = await env.client.callTool({
      name: "get_note",
      arguments: { path: "note-a.md" },
    });
    const text = textContent(result);
    expect(text).toContain("--- Frontmatter ---");
    expect(text).toContain(`status: "active"`);
    expect(text).toContain("Tags:");
    expect(text).toContain("draft");
    expect(text).toContain("Links to");
  });

  it("escapes generated frontmatter and tag labels", async () => {
    const dirtyKey = "dirty\x7fkey";
    const dirtyValue = "value\x7fvalue";
    const dirtyTag = "dirty\x7ftag";
    await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "dirty-metadata.md",
        content: "Body stays raw.",
        frontmatter: JSON.stringify({ [dirtyKey]: dirtyValue, tags: [dirtyTag] }),
      },
    });

    const result = await env.client.callTool({
      name: "get_note",
      arguments: { path: "dirty-metadata.md" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('dirty\\x7fkey: "value\\x7fvalue"');
    expect(text).toContain('tags: ["dirty\\x7ftag"]');
    expect(text).toContain("Tags: dirty\\x7ftag");
    expect(text).not.toContain(dirtyKey);
    expect(text).not.toContain(dirtyValue);
    expect(text).not.toContain(dirtyTag);
  });

  it("returns isError for a missing note with sanitized message", async () => {
    const result = await env.client.callTool({
      name: "get_note",
      arguments: { path: "does-not-exist.md" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    // No absolute paths, no OS error codes leaked.
    expect(text).not.toMatch(/[A-Z]:\\/);
    expect(text).not.toMatch(/^\/[a-z]/);
  });

  it("rejects a path traversal attempt with isError, not a crash", async () => {
    const result = await env.client.callTool({
      name: "get_note",
      arguments: { path: "../../../etc/passwd" },
    });
    expect(isError(result)).toBe(true);
  });

  it("escapes control characters in missing section errors", async () => {
    const result = await env.client.callTool({
      name: "get_note",
      arguments: { path: "note-a.md", section: "Missing\nHeading" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain('Section not found: "Missing\\nHeading" in note-a.md');
    expect(text).not.toContain("Missing\nHeading");
  });

  it("escapes control characters in missing block errors", async () => {
    const result = await env.client.callTool({
      name: "get_note",
      arguments: { path: "note-a.md", block: "bad\nblock" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain('Block not found: "^bad\\nblock" in note-a.md');
    expect(text).not.toContain("bad\nblock");
  });
});

describe("read handlers — list_notes", () => {
  it("lists every markdown note in the vault with a total count", async () => {
    const result = await env.client.callTool({
      name: "list_notes",
      arguments: {},
    });
    const text = textContent(result);
    // Fixture has 7 .md files (6 + nested)
    expect(text).toMatch(/Found 7 note/);
    expect(text).toContain("note-a.md");
    expect(text).toContain("nested/note-d.md");
  });

  it("filters by folder", async () => {
    const result = await env.client.callTool({
      name: "list_notes",
      arguments: { folder: "nested" },
    });
    const text = textContent(result);
    expect(text).toContain("note-d.md");
    expect(text).not.toContain("note-a.md");
  });

  it("caps output at `limit` while still reporting full total", async () => {
    const result = await env.client.callTool({
      name: "list_notes",
      arguments: { limit: 2 },
    });
    const text = textContent(result);
    expect(text).toContain("Found 7 note");
    expect(text).toContain("showing first 2");
  });

  it("escapes folder labels and listed note paths", async () => {
    const dirtyFolder = "list\x7ffolder";
    const dirtyPath = `${dirtyFolder}/note\x7fname.md`;
    await env.client.callTool({
      name: "create_note",
      arguments: { path: dirtyPath, content: "Listed note." },
    });

    const result = await env.client.callTool({
      name: "list_notes",
      arguments: { folder: dirtyFolder },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('Found 1 note(s) in "list\\x7ffolder"');
    expect(text).toContain("list\\x7ffolder/note\\x7fname.md");
    expect(text).not.toContain(dirtyFolder);
    expect(text).not.toContain(dirtyPath);
  });
});

describe("read handlers — get_daily_note", () => {
  it("reads today's daily note when requested by date", async () => {
    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "2026-04-24" },
    });
    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("Daily Note: 2026-04-24");
    expect(text).toContain("daily/2026-04-24.md");
    expect(text).toContain("Daily note fixture");
  });

  it("returns isError when no daily note exists for the requested date", async () => {
    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "1999-01-01" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/not found/i);
  });

  it("escapes control characters in configured missing daily-note paths", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "daily\nnotes", format: "YYYY-MM-DD" }),
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "1999-01-01" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain('expected at "daily\\nnotes/1999-01-01.md"');
    expect(text).not.toContain("daily\nnotes");
  });

  it("escapes generated daily-note frontmatter labels", async () => {
    const dirtyKey = "daily\x7fkey";
    const dirtyValue = "daily\x7fvalue";
    await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "daily/2026-05-08.md",
        content: "Daily body.",
        frontmatter: JSON.stringify({ [dirtyKey]: dirtyValue }),
      },
    });

    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "2026-05-08" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('daily\\x7fkey: "daily\\x7fvalue"');
    expect(text).not.toContain(dirtyKey);
    expect(text).not.toContain(dirtyValue);
  });

  it("rejects malformed dates at the schema layer", async () => {
    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "not-a-date" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/YYYY-MM-DD|validation|regex/i);
  });

  it("rejects calendar-impossible dates instead of normalizing them", async () => {
    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "2026-02-31" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/Invalid date/);
  });
});

describe("read handlers — search_by_frontmatter", () => {
  it("finds notes by scalar frontmatter property (case-insensitive)", async () => {
    const result = await env.client.callTool({
      name: "search_by_frontmatter",
      arguments: { property: "status", value: "ACTIVE" },
    });
    const text = textContent(result);
    expect(text).toContain("note-a.md");
    expect(text).not.toContain("note-b.md");
  });

  it("matches within array-valued frontmatter (e.g., tags: [review])", async () => {
    const result = await env.client.callTool({
      name: "search_by_frontmatter",
      arguments: { property: "tags", value: "review" },
    });
    const text = textContent(result);
    // Both note-a and note-b have `review` in their `tags` array.
    expect(text).toContain("note-a.md");
    expect(text).toContain("note-b.md");
  });

  it("returns a friendly message when nothing matches", async () => {
    const result = await env.client.callTool({
      name: "search_by_frontmatter",
      arguments: { property: "status", value: "cancelled" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No notes found/i);
  });

  it("escapes control characters in no-match property and value labels", async () => {
    const result = await env.client.callTool({
      name: "search_by_frontmatter",
      arguments: { property: "status\nfield", value: "cancelled\nvalue" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain('frontmatter "status\\nfield" matching "cancelled\\nvalue"');
    expect(text).not.toContain("status\nfield");
    expect(text).not.toContain("cancelled\nvalue");
  });

  it("escapes control characters in matched frontmatter output", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "frontmatter-dirty.md"),
      "---\nstatus: \"tab\\tvalue\"\n---\n# Dirty frontmatter\n",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "search_by_frontmatter",
      arguments: { property: "status", value: "tab\tvalue" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain('"status" matches "tab\\tvalue"');
    expect(text).toContain('status: "tab\\tvalue"');
    expect(text).not.toContain("tab\tvalue");
  });

  it("scopes to a folder when requested", async () => {
    const result = await env.client.callTool({
      name: "search_by_frontmatter",
      arguments: { property: "status", value: "active", folder: "nested" },
    });
    // note-a.md (with status=active) is NOT under nested/, so no match here.
    expect(textContent(result)).toMatch(/No notes found/i);
  });
});

describe("read handlers — get_recent_notes", () => {
  it("returns notes sorted by mtime descending", async () => {
    const result = await env.client.callTool({
      name: "get_recent_notes",
      arguments: { limit: 50 },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    // All fixture notes are present; the header reports the total.
    expect(text).toMatch(/note-a\.md/);
    expect(text).toMatch(/orphan\.md/);
  });

  it("respects the limit", async () => {
    const result = await env.client.callTool({
      name: "get_recent_notes",
      arguments: { limit: 2 },
    });
    const text = textContent(result);
    const noteLines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(noteLines).toHaveLength(2);
  });

  it("reflects note mtime changes between repeated calls", async () => {
    await env.client.callTool({
      name: "get_recent_notes",
      arguments: { limit: 5 },
    });

    const notePath = path.join(env.vaultDir, "recent-refresh.md");
    await fs.writeFile(notePath, "freshly touched\n", "utf-8");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(notePath, future, future);

    const result = await env.client.callTool({
      name: "get_recent_notes",
      arguments: { limit: 1 },
    });
    expect(isError(result)).toBe(false);
    const noteLines = textContent(result).split("\n").filter((l) => l.startsWith("- "));
    expect(noteLines[0]).toContain("recent-refresh.md");
  });

  it("filters with relative since spans", async () => {
    const result = await env.client.callTool({
      name: "get_recent_notes",
      arguments: { since: "1h", limit: 50 },
    });
    expect(isError(result)).toBe(false);
    // Fresh fixtures are < 1h old, so all should pass through.
    const text = textContent(result);
    expect(text).toMatch(/note-a\.md/);
  });

  it("excludes notes older than since", async () => {
    const result = await env.client.callTool({
      name: "get_recent_notes",
      // Anchored well in the future — every fixture's mtime is before this.
      arguments: { since: "2099-01-01" },
    });
    expect(textContent(result)).toMatch(/No notes modified since/i);
  });

  it("rejects invalid since strings", async () => {
    const result = await env.client.callTool({
      name: "get_recent_notes",
      arguments: { since: "not-a-date" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/Invalid 'since' value/i);
  });

  it("escapes control characters in invalid since values", async () => {
    const result = await env.client.callTool({
      name: "get_recent_notes",
      arguments: { since: "bad\nsince" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain('Invalid \'since\' value: "bad\\nsince"');
    expect(text).not.toContain("bad\nsince");
  });
});

describe("read handlers — get_vault_stats", () => {
  it("returns headline metrics for the fixture vault", async () => {
    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/Notes:\s+\d+/);
    expect(text).toMatch(/Total bytes:\s+\d/);
    expect(text).toMatch(/Total words:\s+\d/);
    expect(text).toMatch(/Unique tags:\s+\d/);
    expect(text).toMatch(/Untagged notes:\s+\d/);
    expect(text).toMatch(/Most recent:\s+\S+\.md/);
  });

  it("reflects note mtime changes between repeated stats calls", async () => {
    await env.client.callTool({
      name: "get_vault_stats",
      arguments: {},
    });

    const notePath = path.join(env.vaultDir, "stats-refresh.md");
    await fs.writeFile(notePath, "fresh stats note\n#stats\n", "utf-8");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(notePath, future, future);

    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/Most recent:\s+stats-refresh\.md/);
  });

  it("scopes to a folder", async () => {
    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: { folder: "nested" },
    });
    const text = textContent(result);
    expect(text).toMatch(/folder: nested/);
    // Only nested/note-d.md sits there.
    expect(text).toMatch(/Notes:\s+1/);
  });

  it("escapes folder labels and most-recent note paths", async () => {
    const dirtyFolder = "stats\x7ffolder";
    const dirtyPath = `${dirtyFolder}/recent\x7fnote.md`;
    await env.client.callTool({
      name: "create_note",
      arguments: { path: dirtyPath, content: "Stats note." },
    });

    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: { folder: dirtyFolder },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("Vault stats (folder: stats\\x7ffolder)");
    expect(text).toContain("Most recent:     stats\\x7ffolder/recent\\x7fnote.md");
    expect(text).not.toContain(dirtyFolder);
    expect(text).not.toContain(dirtyPath);
  });

  it("escapes folder labels in empty-folder output", async () => {
    const dirtyFolder = "empty\x7fstats";
    await fs.mkdir(path.join(env.vaultDir, dirtyFolder), { recursive: true });

    const result = await env.client.callTool({
      name: "get_vault_stats",
      arguments: { folder: dirtyFolder },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('No notes in "empty\\x7fstats"');
    expect(text).not.toContain(dirtyFolder);
  });
});

describe("read handlers — resolve_alias", () => {
  it("resolves an alias declared in frontmatter", async () => {
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "people/jane.md",
        frontmatter: JSON.stringify({ aliases: ["Jane Doe", "JD"] }),
        content: "# Jane Doe\n\nProfile.",
      },
    });
    expect(isError(result)).toBe(false);

    const r1 = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "Jane Doe", includeBasename: false },
    });
    expect(textContent(r1)).toMatch(/people\/jane\.md/);
    expect(textContent(r1)).toMatch(/Alias matches \(1\)/);

    // Case-insensitive
    const r2 = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "jane doe", includeBasename: false },
    });
    expect(textContent(r2)).toMatch(/people\/jane\.md/);
  });

  it("matches basename when includeBasename is true (default)", async () => {
    const result = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "note-a" },
    });
    expect(textContent(result)).toMatch(/Basename matches/);
    expect(textContent(result)).toMatch(/note-a\.md/);
  });

  it("reflects alias edits between repeated lookups", async () => {
    const first = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "Warm Alias", includeBasename: false },
    });
    expect(textContent(first)).toMatch(/No alias or basename match/i);

    const notePath = path.join(env.vaultDir, "alias-refresh.md");
    await fs.writeFile(
      notePath,
      [
        "---",
        "aliases:",
        "  - Warm Alias",
        "---",
        "",
        "# Alias Refresh",
        "",
      ].join("\n"),
      "utf-8",
    );
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(notePath, future, future);

    const second = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "Warm Alias", includeBasename: false },
    });
    expect(isError(second)).toBe(false);
    expect(textContent(second)).toMatch(/alias-refresh\.md/);
  });

  it("returns a friendly message when nothing matches", async () => {
    const result = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "nope-not-a-real-alias-xyz" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No alias or basename match/i);
  });

  it("escapes control characters in no-match alias labels", async () => {
    const result = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "nope\nalias" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain('No alias or basename match for "nope\\nalias"');
    expect(text).not.toContain("nope\nalias");
  });
});
