// Regression tests for src/tools/tags.ts schema validation and behavior.
//
// Origin: M9 audit finding flagged the rename_tag oldName/newName regex
// `^[^#\s/][^\s]*$` as rejecting hierarchical tag names like
// `project/alpha`. Manual verification shows this is a FALSE POSITIVE -
// the leading character class `[^#\s/]` only excludes `/` as the first
// character; subsequent slashes are matched by `[^\s]*`. These tests
// pin the accepted/rejected name patterns so future regex tweaks can't
// silently break hierarchical renames.
//
// Also exercises end-to-end rename_tag with hierarchical=true to confirm
// that renaming a parent rebases its children (project -> client also
// rebases project/alpha -> client/alpha).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({
    extraFiles: {
      "hier/parent.md": `---
tags:
  - project
---
# Parent

Has a top-level #project tag.
`,
      "hier/child.md": `---
tags:
  - project/alpha
---
# Child

Nested #project/alpha tag.
`,
      "hier/grandchild.md": `# Grandchild

Deeply nested #project/alpha/beta tag.
`,
    },
  });
});

afterEach(async () => {
  await env.cleanup();
});

describe("regression M9: rename_tag schema accepts hierarchical names (false positive)", () => {
  it("accepts a hierarchical oldName like 'project/alpha'", async () => {
    // If the schema rejected hierarchical names this call would surface as
    // isError with a validation message. It should reach the handler and
    // simply report zero matches (no such tag in the default fixture
    // vault, but `project/alpha` exists from extraFiles -> handler runs).
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: {
        oldName: "project/alpha",
        newName: "project/beta",
        dryRun: true,
      },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(
      /Would rewrite #project\/alpha → #project\/beta/,
    );
  });

  it("accepts a hierarchical newName like 'client/alpha'", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: {
        oldName: "project",
        newName: "client/sub",
        hierarchical: false,
        dryRun: true,
      },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(
      /Would rewrite #project → #client\/sub/,
    );
  });

  it("rejects a name beginning with '#' (the leading-hash form)", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "#project", newName: "client" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/validation|invalid|must not start/i);
  });

  it("rejects a name with a leading space", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: " leading-space", newName: "client" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/validation|invalid|must not start/i);
  });

  it("rejects a name beginning with '/' (malformed nested form)", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "/leading-slash", newName: "client" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/validation|invalid|must not start/i);
  });

  it("rejects a name containing internal whitespace", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "tag with space", newName: "client" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/validation|invalid|must not start/i);
  });
});

describe("regression M9: rename_tag hierarchical rebases nested children", () => {
  it("with hierarchical=true (default), renaming 'project' also rewrites 'project/alpha'", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "project", newName: "client", confirmTag: "client" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/Rewrote #project → #client/);
    expect(textContent(result)).toMatch(/and nested sub-tags/);

    // Children should now live under #client.
    const childSearch = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "client/alpha" },
    });
    expect(textContent(childSearch)).toContain("hier/child.md");

    const grandSearch = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "client/alpha/beta" },
    });
    expect(textContent(grandSearch)).toContain("hier/grandchild.md");

    // The old parent tag should be gone.
    const oldSearch = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "project" },
    });
    expect(textContent(oldSearch)).toMatch(/No notes found/i);
  });

  it("with hierarchical=false, renaming 'project' leaves 'project/alpha' untouched", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: {
        oldName: "project",
        newName: "client",
        confirmTag: "client",
        hierarchical: false,
      },
    });
    expect(isError(result)).toBe(false);
    // The parent moved, the children did not.
    const child = await env.client.callTool({
      name: "search_by_tag",
      arguments: { tag: "project/alpha" },
    });
    expect(textContent(child)).toContain("hier/child.md");
  });
});

describe("regression M9: rename_tag input guardrails", () => {
  it("rejects identical oldName and newName with a clear handler message", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "project", newName: "project" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/must differ/i);
  });

  it("rejects empty oldName via min(1)", async () => {
    const result = await env.client.callTool({
      name: "rename_tag",
      arguments: { oldName: "", newName: "client" },
    });
    expect(isError(result)).toBe(true);
  });
});
