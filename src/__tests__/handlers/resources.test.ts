import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});
