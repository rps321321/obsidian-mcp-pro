import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";
import { setMaxNoteFileBytesForTests } from "../../lib/vault.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  setMaxNoteFileBytesForTests(null);
  await env.cleanup();
});

describe("tag handlers — list_tags", () => {
  it("enumerates unique tags across the vault with counts", async () => {
    const result = await env.client.callTool({ name: "list_tags", arguments: {} });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    // Fixture tags (normalized lowercase): draft, review, lonely, nested/archive
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: list_tags values]");
    expect(text).toMatch(/#draft/);
    expect(text).toMatch(/#review/);
    expect(text).toMatch(/#lonely/);
    expect(text).toMatch(/#nested\/archive/);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("escapes frontmatter tag labels in list output", async () => {
    const dirtyTag = "dirty\x7ftag";
    await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "dirty-tag.md",
        content: "Body.",
        frontmatter: JSON.stringify({ tags: [dirtyTag] }),
      },
    });

    const result = await env.client.callTool({
      name: "list_tags",
      arguments: { sortBy: "name" },
    });

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(isError(result)).toBe(false);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: list_tags values]");
    expect(text).toContain("#dirty\\x7ftag (1 note)");
    expect(text).not.toContain(dirtyTag);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("sorts by count desc by default (review appears in 2 notes)", async () => {
    const result = await env.client.callTool({ name: "list_tags", arguments: {} });
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
      name: "list_tags",
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
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const pathMarkers = [...text.matchAll(/\[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path\]/g)];
    expect(pathMarkers).toHaveLength(2);
    expect(text).toContain("note-a.md");
    expect(text).toContain("note-b.md");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path: note-a.md]");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path: note-b.md]");
    expect(text).not.toContain("orphan.md");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
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

  it("escapes control characters in the searched tag label", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "does-not\nexist" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("No notes found with tag #does-not\\nexist");
    expect(text).not.toContain("does-not\nexist");
  });

  it("includes a 200-char preview when includeContent=true", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "review", includeContent: true },
    });
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    // The body of note-b starts with its frontmatter delimiter in a preview.
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path]");
    expect(text).toContain("note-a.md");
    expect(text).toContain("note-b.md");
    // Frontmatter is now stripped from previews, so verify body content appears instead.
    expect(text).toMatch(/Note A|Note B/);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag preview]");
    expect(text).toContain("# Note A\\n\\nLinks to [[note-b]]");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path: note-a.md]");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: tag preview: note-a.md]");
    expect(text).not.toContain("# Note A\n\nLinks to [[note-b]]");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("honors maxResults cap", async () => {
    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "review", maxResults: 1 },
    });
    const text = textContent(result);
    expect(text).toMatch(/Found 1 note with tag #review/);
  });

  it("refreshes the warm tag index after a new note appears", async () => {
    await env.client.callTool({ name: "list_tags", arguments: {} });

    await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "fresh-tag.md",
        content: "A new indexed note. #freshcache",
      },
    });

    const result = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "freshcache" },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path]");
    expect(text).toContain("fresh-tag.md");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_by_tag result path: fresh-tag.md]");
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

  it("marks skipped note paths in rename warnings as untrusted", async () => {
    const dirtyPath = "dirty\x7ffailed.md";
    await env.cleanup();
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "ok.md": "#draft\n",
        [dirtyPath]: `${"x".repeat(64)}\n#draft\n`,
      },
    });
    setMaxNoteFileBytesForTests(20);

    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "draft", newName: "wip", dryRun: true },
    });

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(isError(result)).toBe(false);
    expect(text).toContain("Skipped due to errors: 1");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: rename_tag failed note: dirty\\x7ffailed.md]");
    expect(text).toContain("dirty\\x7ffailed.md: Note file exceeds size cap");
    expect(text).not.toContain(dirtyPath);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe("rename_tag failed notes");

    await expect(fs.readFile(path.join(env.vaultDir, "ok.md"), "utf-8")).resolves.toBe("#draft\n");
  });

  it("aborts rename_tag when elicitation confirms the wrong tag", async () => {
    await env.cleanup();
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: () => ({
        action: "accept",
        content: { confirmTag: "wrong" },
      }),
    });

    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "draft", newName: "wip" },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toContain("Confirmation tag did not match #wip");
    const search = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "draft" },
    });
    expect(textContent(search)).toContain("note-a.md");
  });

  it("renames after elicitation confirms the new tag", async () => {
    await env.cleanup();
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: (request) => {
        expect(request.params.message).toContain("across the vault");
        return {
          action: "accept",
          content: { confirmTag: "wip" },
        };
      },
    });

    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "draft", newName: "wip" },
    });

    expect(isError(result)).toBe(false);
    const search = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "wip" },
    });
    expect(textContent(search)).toContain("note-a.md");
  });

  it("rejects new tag names the parser cannot round-trip", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "draft", newName: "client.name" },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/tag parser|validation/i);
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
