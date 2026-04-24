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
