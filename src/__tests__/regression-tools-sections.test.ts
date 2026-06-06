import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import {
  createTestEnv,
  textContent,
  isError,
  type TestEnv,
} from "./handlers/harness.js";

/**
 * Regression tests for src/tools/sections.ts.
 *
 * Covers:
 *   C3 (CRITICAL): ReDoS via `replace_in_note` with arbitrary regex.
 *   H11: `insert_at_section` reporting JS code-units instead of UTF-8 bytes.
 *   O8:  `edit_block` not normalizing leading `^` on block ids.
 *
 * Each `it` block pins one observable behavior so a future change to the
 * sections-tool surface has to do so deliberately.
 */

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("regression: replace_in_note ReDoS guards (C3)", () => {
  it("returns an error in under 500ms for a 1MB note with `(a+)+$`", async () => {
    // 1MB of `a` characters with a trailing `b` — classic catastrophic
    // backtracking shape for `(a+)+$`. Without the input-size cap, this
    // hangs the per-file write lock indefinitely.
    const big = "a".repeat(1_000_001) + "b";
    await fs.writeFile(path.join(env.vaultDir, "redos.md"), big, "utf-8");

    const started = Date.now();
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "redos.md",
        find: "(a+)+$",
        replace: "X",
        regex: true,
      },
    });
    const elapsed = Date.now() - started;

    expect(isError(result)).toBe(true);
    expect(elapsed).toBeLessThan(500);
    // The error should mention the size cap, not just generic failure.
    expect(textContent(result)).toMatch(/too large|targeted/i);

    // File on disk is unchanged — the input-size guard runs before replace.
    const onDisk = await fs.readFile(path.join(env.vaultDir, "redos.md"), "utf-8");
    expect(onDisk.length).toBe(big.length);
  });

  it("rejects nested quantified regex groups before matching", async () => {
    await fs.writeFile(path.join(env.vaultDir, "redos-shape.md"), "abc\n", "utf-8");

    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "redos-shape.md",
        find: "(a+)+$",
        replace: "X",
        regex: true,
      },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/unsafe regex pattern|nested quantifier/i);

    const onDisk = await fs.readFile(path.join(env.vaultDir, "redos-shape.md"), "utf-8");
    expect(onDisk).toBe("abc\n");
  });

  it("rejects invalid regex flags with a clean error mentioning the bad flag", async () => {
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "note-c.md",
        find: "Standalone",
        replace: "REPLACED",
        regex: true,
        flags: "x",
      },
    });
    expect(isError(result)).toBe(true);
    const msg = textContent(result);
    expect(msg).toMatch(/invalid regex flag/i);
    expect(msg).toContain("x");

    // File content untouched.
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-c.md"), "utf-8");
    expect(onDisk).toContain("Standalone");
  });

  it("rejects a find pattern longer than 4096 chars", async () => {
    const huge = "a".repeat(4097);
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "note-c.md",
        find: huge,
        replace: "X",
        regex: true,
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/too long|targeted/i);
  });

  it("rejects an unknown flag character (single-letter allowlist only)", async () => {
    // 'z' is not a valid JS regex flag and is not in our allowlist.
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "note-c.md",
        find: "Standalone",
        replace: "REPLACED",
        regex: true,
        flags: "gz",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/invalid regex flag/i);
  });

  it("still performs legitimate regex replacements with valid flags", async () => {
    // Sanity check that the hardening didn't break the happy path.
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "note-c.md",
        find: "Standalone",
        replace: "REPLACED",
        regex: true,
        flags: "g",
      },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "note-c.md"), "utf-8");
    expect(onDisk).toContain("REPLACED");
    expect(onDisk).not.toContain("Standalone");
  });

  it("allows optional grouped regexes that are not repeated", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "optional-url.md"),
      "https://example.com example.com\n",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "optional-url.md",
        find: "(https?:\\/\\/)?example\\.com",
        replace: "site",
        regex: true,
        flags: "g",
      },
    });

    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "optional-url.md"), "utf-8");
    expect(onDisk).toBe("site site\n");
  });

  it("treats replacement dollar tokens literally when regex=false", async () => {
    await fs.writeFile(path.join(env.vaultDir, "literal-replace.md"), "foo foo\n", "utf-8");

    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "literal-replace.md",
        find: "foo",
        replace: "$&",
        regex: false,
      },
    });

    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "literal-replace.md"), "utf-8");
    expect(onDisk).toBe("$& $&\n");
  });

  it("returns a SyntaxError-shaped error for malformed regex (try/catch)", async () => {
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "note-c.md",
        find: "(unclosed",
        replace: "X",
        regex: true,
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/invalid regex pattern/i);
  });
});

describe("regression: insert_at_section UTF-8 byte count (H11)", () => {
  it("reports UTF-8 byte length for emoji content, not JS code units", async () => {
    // Section fixture with a known heading so we can target it.
    const note = "# Tasks\n\n- existing\n";
    await fs.writeFile(path.join(env.vaultDir, "h11.md"), note, "utf-8");

    // The fire emoji is one code-point but two UTF-16 code units. In UTF-8
    // it serializes to 4 bytes. JS `string.length` would report 2.
    const emoji = "🔥"; // U+1F525, fire emoji, surrogate pair
    expect(emoji.length).toBe(2);
    expect(Buffer.byteLength(emoji, "utf-8")).toBe(4);

    const result = await env.client.callTool({
      name: "insert_at_section",
      arguments: {
        path: "h11.md",
        section: "Tasks",
        content: emoji,
        position: "append",
      },
    });
    expect(isError(result)).toBe(false);
    const msg = textContent(result);
    // Should mention 4 bytes, not 2 (the code-unit count).
    expect(msg).toContain("4 bytes");
    expect(msg).not.toContain("2 bytes");
  });
});

describe("regression: section tool output escaping", () => {
  it("escapes control characters in listed heading text", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "dirty-heading.md"),
      "# Clean\n\n## Dirty\tHeading\n\nBody\n",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "list_sections",
      arguments: { path: "dirty-heading.md" },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("## Dirty\\tHeading");
    expect(text).not.toContain("Dirty\tHeading");
  });

  it("re-renders list_sections after a same-size heading edit", async () => {
    await fs.writeFile(path.join(env.vaultDir, "cached-heading.md"), "# Old\n\nBody\n", "utf-8");

    const before = await env.client.callTool({
      name: "list_sections",
      arguments: { path: "cached-heading.md" },
    });
    expect(isError(before)).toBe(false);
    expect(textContent(before)).toContain("# Old");

    const edit = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "cached-heading.md",
        find: "Old",
        replace: "New",
        expectedCount: 1,
      },
    });
    expect(isError(edit)).toBe(false);

    const after = await env.client.callTool({
      name: "list_sections",
      arguments: { path: "cached-heading.md" },
    });

    const text = textContent(after);
    expect(isError(after)).toBe(false);
    expect(text).toContain("# New");
    expect(text).not.toContain("# Old");
  });

  it("escapes control characters in update_section success output", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "update-dirty-heading.md"),
      "# Dirty\tHeading\n\nold body\n",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "update_section",
      arguments: {
        path: "update-dirty-heading.md",
        section: "Dirty\tHeading",
        newBody: "new body",
      },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain('Updated section "Dirty\\tHeading" in update-dirty-heading.md');
    expect(text).not.toContain("Dirty\tHeading");
  });

  it("escapes control characters in insert_at_section success output", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "insert-dirty-heading.md"),
      "# Dirty\tHeading\n\nold body\n",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "insert_at_section",
      arguments: {
        path: "insert-dirty-heading.md",
        section: "Dirty\tHeading",
        content: "inserted",
        position: "append",
      },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain('bytes into "Dirty\\tHeading" (append) in insert-dirty-heading.md');
    expect(text).not.toContain("Dirty\tHeading");
  });

  it("escapes control characters in invalid regex flag errors", async () => {
    const result = await env.client.callTool({
      name: "replace_in_note",
      arguments: {
        path: "note-c.md",
        find: "Standalone",
        replace: "REPLACED",
        regex: true,
        flags: "g\n",
      },
    });

    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain("invalid regex flag '\\n'");
    expect(text).not.toContain("invalid regex flag '\n'");
  });
});

describe("regression: edit_block normalizes leading ^ (O8)", () => {
  it("accepts `^myid` and treats it identically to `myid`", async () => {
    const note = "# Note\n\nFirst paragraph. ^myid\n\nOther stuff.\n";
    await fs.writeFile(path.join(env.vaultDir, "o8.md"), note, "utf-8");

    const result = await env.client.callTool({
      name: "edit_block",
      arguments: {
        path: "o8.md",
        block: "^myid",
        newContent: "Replaced paragraph.",
      },
    });
    expect(isError(result)).toBe(false);
    // The success message echoes the bare id.
    expect(textContent(result)).toContain("^myid");

    const onDisk = await fs.readFile(path.join(env.vaultDir, "o8.md"), "utf-8");
    expect(onDisk).toContain("Replaced paragraph. ^myid");
    expect(onDisk).not.toContain("First paragraph.");
  });

  it("still accepts a bare `myid` (no regression on the original form)", async () => {
    const note = "# Note\n\nFirst paragraph. ^myid\n\nOther stuff.\n";
    await fs.writeFile(path.join(env.vaultDir, "o8-bare.md"), note, "utf-8");

    const result = await env.client.callTool({
      name: "edit_block",
      arguments: {
        path: "o8-bare.md",
        block: "myid",
        newContent: "Another replacement.",
      },
    });
    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "o8-bare.md"), "utf-8");
    expect(onDisk).toContain("Another replacement. ^myid");
  });

  it("rejects a `^`-only block id (empty after stripping)", async () => {
    const result = await env.client.callTool({
      name: "edit_block",
      arguments: {
        path: "note-c.md",
        block: "^",
        newContent: "x",
      },
    });
    // The zod refine catches this at the wire boundary, so it surfaces as an
    // error response rather than a successful no-op.
    expect(isError(result)).toBe(true);
  });

  it("does not delete the heading immediately above a block anchor", async () => {
    const note = "# Tasks\nTodo item ^task\n\nOther stuff.\n";
    await fs.writeFile(path.join(env.vaultDir, "heading-block.md"), note, "utf-8");

    const result = await env.client.callTool({
      name: "edit_block",
      arguments: {
        path: "heading-block.md",
        block: "task",
        newContent: "Updated todo",
      },
    });

    expect(isError(result)).toBe(false);
    const onDisk = await fs.readFile(path.join(env.vaultDir, "heading-block.md"), "utf-8");
    expect(onDisk).toContain("# Tasks\nUpdated todo ^task");
    expect(onDisk).not.toContain("Todo item");
  });
});
