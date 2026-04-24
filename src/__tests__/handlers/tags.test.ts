import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("tag handlers — get_tags", () => {
  it("enumerates unique tags across the vault with counts", async () => {
    const result = await env.client.callTool({ name: "get_tags", arguments: {} });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    // Fixture tags (normalized lowercase): draft, review, lonely, nested/archive
    expect(text).toMatch(/#draft/);
    expect(text).toMatch(/#review/);
    expect(text).toMatch(/#lonely/);
    expect(text).toMatch(/#nested\/archive/);
  });

  it("sorts by count desc by default (review appears in 2 notes)", async () => {
    const result = await env.client.callTool({ name: "get_tags", arguments: {} });
    const text = textContent(result);
    // `#review` appears in note-a AND note-b → 2 notes
    expect(text).toMatch(/#review \(2 notes\)/);
    // Position check: `review` should be listed before `lonely` (which has 1 note).
    const reviewIdx = text.indexOf("#review");
    const lonelyIdx = text.indexOf("#lonely");
    expect(reviewIdx).toBeGreaterThan(0);
    expect(lonelyIdx).toBeGreaterThan(reviewIdx);
  });

  it("sorts alphabetically when sortBy=name", async () => {
    const result = await env.client.callTool({
      name: "get_tags",
      arguments: { sortBy: "name" },
    });
    const text = textContent(result);
    const draftIdx = text.indexOf("#draft");
    const lonelyIdx = text.indexOf("#lonely");
    const reviewIdx = text.indexOf("#review");
    expect(draftIdx).toBeGreaterThan(0);
    expect(draftIdx).toBeLessThan(lonelyIdx);
    expect(lonelyIdx).toBeLessThan(reviewIdx);
  });
});

describe("tag handlers — search_by_tag", () => {
  it("finds notes tagged with the exact tag", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "review" },
    });
    const text = textContent(result);
    expect(text).toContain("note-a.md");
    expect(text).toContain("note-b.md");
    expect(text).not.toContain("orphan.md");
  });

  it("accepts tags with or without a leading '#'", async () => {
    const withHash = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "#draft" },
    });
    const withoutHash = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "draft" },
    });
    expect(textContent(withHash)).toContain("note-a.md");
    expect(textContent(withoutHash)).toContain("note-a.md");
  });

  it("matches nested child tags when querying the parent", async () => {
    // note-d.md has #nested/archive — searching for `nested` should find it.
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "nested" },
    });
    expect(textContent(result)).toContain("note-d.md");
  });

  it("returns a friendly message for an unknown tag", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "does-not-exist" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No notes found/i);
  });

  it("includes a 200-char preview when includeContent=true", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "review", includeContent: true },
    });
    const text = textContent(result);
    // The body of note-b starts with its frontmatter delimiter in a preview.
    expect(text).toContain("note-a.md");
    expect(text).toContain("note-b.md");
    expect(text).toMatch(/---/); // preview of frontmatter
  });

  it("honors maxResults cap", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "review", maxResults: 1 },
    });
    const text = textContent(result);
    expect(text).toMatch(/Found 1 note with tag #review/);
  });
});
