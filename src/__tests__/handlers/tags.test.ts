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

describe("tag handlers — rename_tag", () => {
  it("rewrites both inline #tag and frontmatter tags vault-wide", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "review", newName: "audit" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/Rewrote #review → #audit/);
    expect(text).toMatch(/Files affected: \d+/);

    // Verify by searching for the new tag.
    const search = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "audit" },
    });
    expect(textContent(search)).toContain("note-a.md");
    expect(textContent(search)).toContain("note-b.md");
  });

  it("dryRun reports counts without writing", async () => {
    const dry = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "draft", newName: "wip", dryRun: true },
    });
    expect(textContent(dry)).toMatch(/Would rewrite #draft → #wip/);

    // Note still has #draft (no write happened).
    const search = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "draft" },
    });
    expect(textContent(search)).toContain("note-a.md");
  });

  // Regression for the v1.8.1-audit HIGH finding: rename_tag must hold
  // the vault-wide rewrite lock so a concurrent move_note's plan/apply
  // pipeline can't see bytes shifting underneath it. Without the lock,
  // running rename_tag and move_note in parallel surfaces "content
  // changed during move" failures and leaves stale links. We assert by
  // running both concurrently and checking the move's `failedReferrers`
  // is empty.
  it("does not race move_note when both run concurrently on the same vault", async () => {
    const [moveResult, renameResult] = await Promise.all([
      env.client.callTool({
        name: "move_note",
        arguments: { oldPath: "note-c.md", newPath: "archive/note-c.md" },
      }),
      env.client.callTool({
        name: "rename_tag",
        arguments: { oldName: "review", newName: "audit" },
      }),
    ]);
    expect(isError(moveResult)).toBe(false);
    expect(isError(renameResult)).toBe(false);
    // The move's success message includes "Updated references" or
    // "Moved" — what matters is that we don't surface failed referrers
    // from the bytes-shifted-under-us race.
    const moveText = textContent(moveResult);
    expect(moveText).not.toMatch(/could not be updated/);
    expect(moveText).not.toMatch(/content changed during move/);
  });
});
