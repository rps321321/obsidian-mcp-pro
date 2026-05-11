import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";

// ---------------------------------------------------------------------------
// Finding #19 (LOW): create_note / update_frontmatter validated that the
// `frontmatter`/`properties` arg parsed as JSON but not that the root was
// a YAML-mapping-compatible plain object. `JSON.parse('"hello"')` →
// `"hello"`; `JSON.parse('[1,2]')` → `[1, 2]`. Both used to slip past the
// type assertion and reach `matter.stringify`, producing nonsense YAML.
//
// Finding #10 (MEDIUM): create_daily_note template substitution only swapped
// `{{date}}`. Real Obsidian templates routinely use `{{title}}` and
// `{{time}}` too — those leaked through verbatim, leaving placeholder
// strings inside fresh daily notes.
//
// This file exercises the JSON-object check on both write tools and the
// extended template-placeholder pass on create_daily_note.
// ---------------------------------------------------------------------------

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

describe("Finding #19: create_note frontmatter must be a JSON object", () => {
  it("rejects a JSON string root with a clear object/JSON message", async () => {
    env = await createTestEnv();
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "regression-fm-string.md",
        content: "body",
        frontmatter: '"hello"',
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/object/i);
    expect(textContent(result)).toMatch(/JSON/i);
    // And no file written to disk.
    await expect(
      fs.access(path.join(env.vaultDir, "regression-fm-string.md")),
    ).rejects.toThrow();
  });

  it("rejects a JSON array root", async () => {
    env = await createTestEnv();
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "regression-fm-array.md",
        content: "body",
        frontmatter: "[1,2]",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/object/i);
    await expect(
      fs.access(path.join(env.vaultDir, "regression-fm-array.md")),
    ).rejects.toThrow();
  });

  it("rejects JSON null root (typeof null === 'object')", async () => {
    env = await createTestEnv();
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "regression-fm-null.md",
        content: "body",
        frontmatter: "null",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/object/i);
  });

  it("still succeeds with a valid object frontmatter", async () => {
    env = await createTestEnv();
    const result = await env.client.callTool({
      name: "create_note",
      arguments: {
        path: "regression-fm-ok.md",
        content: "body",
        frontmatter: '{"status":"draft"}',
      },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(
      path.join(env.vaultDir, "regression-fm-ok.md"),
      "utf-8",
    );
    expect(onDisk).toMatch(/^---\n/);
    expect(onDisk).toMatch(/status: draft/);
    expect(onDisk).toContain("body");
  });
});

describe("Finding #19: update_frontmatter properties must be a JSON object", () => {
  it("rejects an array root for properties", async () => {
    env = await createTestEnv();
    const result = await env.client.callTool({
      name: "update_frontmatter",
      arguments: { path: "note-a.md", properties: "[1,2,3]" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/object/i);
  });

  it("rejects a string root for properties", async () => {
    env = await createTestEnv();
    const result = await env.client.callTool({
      name: "update_frontmatter",
      arguments: { path: "note-a.md", properties: '"oops"' },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/object/i);
  });
});

describe("Finding #10: create_daily_note template substitution covers {{title}}, {{time}}, {{date:FORMAT}}", () => {
  it("substitutes {{title}} with the formatted date (Obsidian semantics)", async () => {
    env = await createTestEnv();
    await fs.writeFile(
      path.join(env.vaultDir, "title-template.md"),
      "# {{title}}\n\nHeader line for {{title}}.\n",
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-03", templatePath: "title-template.md" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(
      path.join(env.vaultDir, "daily/2026-05-03.md"),
      "utf-8",
    );
    expect(onDisk).toContain("# 2026-05-03");
    expect(onDisk).toContain("Header line for 2026-05-03.");
    // No verbatim placeholder leak.
    expect(onDisk).not.toContain("{{title}}");
  });

  it("substitutes {{time}} with a local HH:mm string", async () => {
    env = await createTestEnv();
    await fs.writeFile(
      path.join(env.vaultDir, "time-template.md"),
      "Created at {{time}}\n",
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-04", templatePath: "time-template.md" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(
      path.join(env.vaultDir, "daily/2026-05-04.md"),
      "utf-8",
    );
    // Time is a wall-clock value; match the HH:mm shape, not a specific value.
    expect(onDisk).toMatch(/Created at \d{2}:\d{2}/);
    expect(onDisk).not.toContain("{{time}}");
  });

  it("supports {{date:FORMAT}} for custom moment-style formatting", async () => {
    env = await createTestEnv();
    await fs.writeFile(
      path.join(env.vaultDir, "date-fmt-template.md"),
      "Year: {{date:YYYY}} / Month: {{date:MMMM}}\n",
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-05", templatePath: "date-fmt-template.md" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(
      path.join(env.vaultDir, "daily/2026-05-05.md"),
      "utf-8",
    );
    expect(onDisk).toContain("Year: 2026");
    expect(onDisk).toContain("Month: May");
  });

  it("still replaces plain {{date}} (regression guard for the old behavior)", async () => {
    env = await createTestEnv();
    await fs.writeFile(
      path.join(env.vaultDir, "plain-date-template.md"),
      "Entry for {{date}}.\n",
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "create_daily_note",
      arguments: { date: "2026-05-06", templatePath: "plain-date-template.md" },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(
      path.join(env.vaultDir, "daily/2026-05-06.md"),
      "utf-8",
    );
    expect(onDisk).toContain("Entry for 2026-05-06.");
  });
});
