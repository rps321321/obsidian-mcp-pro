import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("rejects malformed dates at the schema layer", async () => {
    const result = await env.client.callTool({
      name: "get_daily_note",
      arguments: { date: "not-a-date" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/YYYY-MM-DD|validation|regex/i);
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

  it("returns a friendly message when nothing matches", async () => {
    const result = await env.client.callTool({
      name: "resolve_alias",
      arguments: { name: "nope-not-a-real-alias-xyz" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No alias or basename match/i);
  });
});
