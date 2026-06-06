import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, type TestEnv } from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

function firstText(contents: Array<{ text?: string }>): string {
  const first = contents[0];
  expect(first?.text).toBeTypeOf("string");
  return first.text ?? "";
}

describe("MCP resources", () => {
  it("lists static resources and the note template", async () => {
    const resources = await env.client.listResources();
    const listed = resources.resources
      .map((resource) => ({ name: resource.name, uri: resource.uri }))
      .sort((a, b) => a.uri.localeCompare(b.uri));

    expect(listed).toEqual([
      { name: "daily", uri: "obsidian://daily" },
      { name: "tags", uri: "obsidian://tags" },
    ]);

    const templates = await env.client.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({
        name: "note",
        uriTemplate: "obsidian://note/{+path}",
      }),
    ]);
  });

  it("reads note resources through the note URI template", async () => {
    const result = await env.client.readResource({ uri: "obsidian://note/nested/note-d.md" });
    const content = result.contents[0];

    expect(content).toMatchObject({
      uri: "obsidian://note/nested/note-d.md",
      mimeType: "text/markdown",
    });
    expect(firstText(result.contents)).toContain("Nested note that references [[note-a]].");
  });

  it("rejects non-markdown files through the note URI template", async () => {
    await fs.writeFile(path.join(env.vaultDir, "asset.txt"), "hidden resource body", "utf-8");

    let message = "";
    try {
      await env.client.readResource({ uri: "obsidian://note/asset.txt" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/not a markdown note/i);
    expect(message).not.toContain("hidden resource body");
  });

  it("reads the tag index resource as JSON", async () => {
    const result = await env.client.readResource({ uri: "obsidian://tags" });
    const content = result.contents[0];

    expect(content).toMatchObject({
      uri: "obsidian://tags",
      mimeType: "application/json",
    });

    const tags = JSON.parse(firstText(result.contents)) as Record<string, string[]>;
    expect(tags["#review"]).toEqual(expect.arrayContaining(["note-a.md", "note-b.md"]));
    expect(tags["#nested/archive"]).toEqual(["nested/note-d.md"]);
  });

  it("escapes control characters in tag resource JSON labels", async () => {
    const dirtyTag = "resource\x7ftag";
    const dirtyPath = "resource\x7fnote.md";
    await env.client.callTool({
      name: "create_note",
      arguments: {
        path: dirtyPath,
        frontmatter: JSON.stringify({ tags: [dirtyTag] }),
        content: "# Tagged resource note",
      },
    });

    const result = await env.client.readResource({ uri: "obsidian://tags" });
    const text = firstText(result.contents);
    const tags = JSON.parse(text) as Record<string, string[]>;

    expect(tags["#resource\\x7ftag"]).toEqual(["resource\\x7fnote.md"]);
    expect(text).not.toContain(dirtyTag);
    expect(text).not.toContain(dirtyPath);
  });

  it("escapes configured daily-note paths in missing daily resource errors", async () => {
    const dirtyFolder = "daily\nnotes";
    await fs.writeFile(
      path.join(env.vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: dirtyFolder, format: "YYYY-MM-DD" }),
    );

    let message = "";
    try {
      await env.client.readResource({ uri: "obsidian://daily" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("daily\\nnotes/");
    expect(message).not.toContain(dirtyFolder);
  });
});
