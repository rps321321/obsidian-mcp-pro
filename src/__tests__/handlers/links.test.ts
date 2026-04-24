import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

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
    expect(text).toContain("nested/note-d.md");
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
  });

  it("returns a friendly message for a note with no outgoing links", async () => {
    const result = await env.client.callTool({
      name: "get_outlinks",
      arguments: { path: "orphan.md" },
    });
    expect(textContent(result)).toMatch(/No outgoing links/i);
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
  });

  it("hides the no-outlinks bucket when includeOutlinksCheck=false", async () => {
    const result = await env.client.callTool({
      name: "find_orphans",
      arguments: { includeOutlinksCheck: false },
    });
    const text = textContent(result);
    expect(text).not.toMatch(/No outlinks.*links to no other notes/);
  });
});

describe("link handlers — find_broken_links", () => {
  it("identifies the broken link in the fixture", async () => {
    const result = await env.client.callTool({
      name: "find_broken_links",
      arguments: {},
    });
    const text = textContent(result);
    expect(text).toContain("broken.md:");
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
});

describe("link handlers — get_graph_neighbors", () => {
  it("returns direct neighbors at depth=1 with direction=both", async () => {
    const result = await env.client.callTool({
      name: "get_graph_neighbors",
      arguments: { path: "note-a.md", depth: 1 },
    });
    const text = textContent(result);
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
});
