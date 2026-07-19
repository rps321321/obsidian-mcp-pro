import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestEnv,
  textContent,
  isError,
  type TestEnv,
} from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("link handlers — get_backlinks", () => {
  it("lists every source note that wikilinks to the target", async () => {
    // Fixture: note-a and note-d both link to... note-a is a target of note-d.
    // Let's target note-a which is linked from note-d.
    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "note-a.md" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain("nested/note-d.md");
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_backlinks target path]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_backlinks source path]"
    );
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "get_backlinks paths and context"
    );
  });

  it("reports 'No backlinks' for a note nothing links to", async () => {
    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "orphan.md" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No backlinks/i);
  });

  it("returns isError for a non-existent target path", async () => {
    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "does-not-exist.md" },
    });
    expect(isError(result)).toBe(true);
  });

  it("accepts target paths with or without the .md extension", async () => {
    const withExt = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "note-a.md" },
    });
    const withoutExt = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "note-a" },
    });
    expect(textContent(withExt)).toEqual(textContent(withoutExt));
  });

  it("canonicalizes target path dot segments before basename fallback", async () => {
    await env.cleanup();
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "archive/idea.md": "# Archive idea\n",
        "projects/idea.md": "# Project idea\n",
        "ref.md": "Links to [[projects/idea]].\n",
      },
    });

    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "./projects/idea.md" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("ref.md");
    expect(text).toContain("projects/idea.md");
    expect(text).not.toContain("No backlinks found");
  });

  it("escapes control characters in missing target paths", async () => {
    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "missing\nnote" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain("No note found matching path: missing\\nnote");
    expect(text).not.toContain("missing\nnote");
  });

  it("escapes control characters in backlink context lines", async () => {
    const created = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "tab-backlink.md",
        content: "# Tab backlink\n\nLinks to [[note-a]]\twith tab.",
      },
    });
    expect(isError(created)).toBe(false);

    const result = await env.client.callTool({
      name: "get_backlinks",
      arguments: { path: "note-a.md" },
    });
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain("Links to [[note-a]]\\twith tab.");
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_backlinks source path]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_backlinks context]"
    );
    expect(text).not.toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: backlink context: tab-backlink.md:"
    );
    expect(text).not.toContain("note-a]]\twith tab");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "get_backlinks paths and context"
    );
  });
});

describe("link handlers — get_outlinks", () => {
  it("separates valid and broken outgoing links", async () => {
    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "broken.md" },
    });
    const text = textContent(result);
    expect(text).toMatch(/0 valid, 1 broken/);
    expect(text).toContain("does-not-exist");
  });

  it("reports every valid outlink from a well-connected note", async () => {
    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "note-a.md" },
    });
    const text = textContent(result);
    expect(text).toMatch(/1 valid, 0 broken/);
    expect(text).toContain("note-b.md");
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_outlinks source path]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_outlinks resolved path]"
    );
  });

  it("canonicalizes source path dot segments before basename fallback", async () => {
    await env.cleanup();
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "archive/idea.md": "# Archive idea\n",
        "projects/idea.md": "# Project idea\n\nLinks to [[target]].\n",
        "target.md": "# Target\n",
      },
    });

    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "./projects/idea.md" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toMatch(/1 valid, 0 broken/);
    expect(text).toContain("projects/idea.md");
    expect(text).toContain("target.md");
    expect(text).not.toContain("No outgoing links");
  });

  it("canonicalizes wikilink target dot segments before basename fallback", async () => {
    await env.cleanup();
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "archive/idea.md": "# Archive idea\n",
        "projects/idea.md": "# Project idea\n",
        "ref.md": "Links to [[./projects/idea]].\n",
      },
    });

    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "ref.md" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toMatch(/1 valid, 0 broken/);
    expect(text).toContain("projects/idea.md");
    expect(text).not.toContain("archive/idea.md");
  });

  it("refreshes a warm graph before resolving a new source note", async () => {
    const warmed = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "note-a.md" },
    });
    expect(isError(warmed)).toBe(false);

    const created = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "warm-new-source.md",
        content: "# Warm new source\n\nLinks to [[note-a]].",
      },
    });
    expect(isError(created)).toBe(false);

    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "warm-new-source.md" },
    });
    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("Outgoing links from:");
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_outlinks source path]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_outlinks target]"
    );
    expect(text).not.toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: outlink target: warm-new-source.md]"
    );
    expect(text).toContain("note-a");
    expect(text).toContain("note-a.md");
  });

  it("returns a friendly message for a note with no outgoing links", async () => {
    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "orphan.md" },
    });
    expect(textContent(result)).toMatch(/No outgoing links/i);
  });

  it("escapes control characters in missing source paths", async () => {
    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "missing\nnote" },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain("No note found matching path: missing\\nnote");
    expect(text).not.toContain("missing\nnote");
  });

  it("marks displayed broken link targets as untrusted", async () => {
    const created = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "tab-outlink.md",
        content: "# Tab outlink\n\nThis points at [[bad\ttarget]].",
      },
    });
    expect(isError(created)).toBe(false);

    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "tab-outlink.md" },
    });
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_outlinks broken target]"
    );
    expect(text).toContain("bad\\ttarget");
    expect(text).not.toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: broken outlink target: tab-outlink.md]"
    );
    expect(text).not.toContain("bad\ttarget");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "get_outlinks paths and targets"
    );
  });
});

describe("link handlers — find_orphans", () => {
  it("classifies notes into isolated / no-backlinks / no-outlinks buckets", async () => {
    const result = await env.client.callTool({
      name: "find_orphans",
      arguments: {},
    });
    const text = textContent(result);
    expect(text).toContain("Fully isolated");
    // orphan.md has no in/out links → fully isolated.
    expect(text).toContain("orphan.md");
    // note-c has backlinks (from note-b) but no outlinks → no-outlinks bucket.
    expect(text).toContain("note-c.md");
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: find_orphans fully isolated paths]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: find_orphans no-outlink paths]"
    );
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "find_orphans paths"
    );
  });

  it("hides the no-outlinks bucket when includeOutlinksCheck=false", async () => {
    const result = await env.client.callTool({
      name: "find_orphans",
      arguments: { includeOutlinksCheck: false },
    });
    const text = textContent(result);
    expect(text).not.toMatch(/No outlinks.*links to no other notes/);
  });

  it("escapes and marks orphan note paths as untrusted", async () => {
    const dirtyPath = "orphan\x7fpath.md";
    const created = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: dirtyPath,
        content: "# Dirty orphan path\n\nNo links here.",
      },
    });
    expect(isError(created)).toBe(false);

    const result = await env.client.callTool({
      name: "find_orphans",
      arguments: { maxResults: 1000 },
    });

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: find_orphans fully isolated paths]"
    );
    expect(text).toContain("orphan\\x7fpath.md");
    expect(text).not.toContain(dirtyPath);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "find_orphans paths"
    );
  });
});

describe("link handlers — find_broken_links", () => {
  it("identifies the broken link in the fixture", async () => {
    const result = await env.client.callTool({
      name: "find_broken_links",
      arguments: {},
    });
    const text = textContent(result);
    expect(text).toContain("broken.md");
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: find_broken_links source path]"
    );
    expect(text).toContain("does-not-exist");
    expect(text).toMatch(/Total: 1 broken/);
  });

  it("returns clean report when scoped to a folder with no broken links", async () => {
    const result = await env.client.callTool({
      name: "find_broken_links",
      arguments: { folder: "daily" },
    });
    expect(textContent(result)).toMatch(/No broken links/i);
  });

  it("marks broken link report targets as untrusted", async () => {
    const created = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "tab-broken-report.md",
        content: "# Tab broken report\n\nThis points at [[bad\ttarget]].",
      },
    });
    expect(isError(created)).toBe(false);

    const result = await env.client.callTool({
      name: "find_broken_links",
      arguments: {},
    });
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: find_broken_links source path]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: find_broken_links target]"
    );
    expect(text).toContain("bad\\ttarget");
    expect(text).not.toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: broken link target: tab-broken-report.md:"
    );
    expect(text).not.toContain("bad\ttarget");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "find_broken_links paths and targets"
    );
  });
});

describe("link handlers — get_graph_neighbors", () => {
  it("returns direct neighbors at depth=1 with direction=both", async () => {
    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "note-a.md", depth: 1 },
    });
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_graph_neighbors start path]"
    );
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_graph_neighbors path tree]"
    );
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe(
      "get_graph_neighbors paths"
    );
    // note-a links to note-b (outbound) and is linked from note-d (inbound).
    expect(text).toContain("note-b.md");
    expect(text).toContain("nested/note-d.md");
    expect(text).toMatch(/→ note-b\.md/); // outbound arrow
    expect(text).toMatch(/← nested\/note-d\.md/); // inbound arrow
  });

  it("restricts to outbound-only when direction=outbound", async () => {
    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "note-a.md", depth: 1, direction: "outbound" },
    });
    const text = textContent(result);
    expect(text).toContain("note-b.md");
    expect(text).not.toContain("nested/note-d.md");
  });

  it("transitively reaches note-c at depth=2 from note-a (a → b → c)", async () => {
    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "note-a.md", depth: 2, direction: "outbound" },
    });
    const text = textContent(result);
    expect(text).toContain("note-b.md");
    expect(text).toContain("note-c.md");
  });

  it("returns isError for an unresolvable start path", async () => {
    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "does-not-exist", depth: 1 },
    });
    expect(isError(result)).toBe(true);
  });

  it("escapes control characters in unresolvable start paths", async () => {
    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "missing\nstart", depth: 1 },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain("No note found matching path: missing\\nstart");
    expect(text).not.toContain("missing\nstart");
  });

  it("escapes and marks neighbor note paths as untrusted", async () => {
    const dirtyPath = "dirty\x7fneighbor.md";
    const created = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: dirtyPath,
        content: "# Dirty neighbor\n\nLinks to [[note-a]].",
      },
    });
    expect(isError(created)).toBe(false);

    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "note-a.md", depth: 1, direction: "inbound" },
    });

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain(
      "[BEGIN UNTRUSTED VAULT CONTENT: get_graph_neighbors path tree]"
    );
    expect(text).toContain("dirty\\x7fneighbor.md");
    expect(text).not.toContain(dirtyPath);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe(
      "untrusted-vault-content"
    );
  });
});
