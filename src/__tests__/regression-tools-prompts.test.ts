import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEnv, type TestEnv } from "./handlers/harness.js";

// Regression coverage for M12: the find-stale-notes prompt previously instructed
// the model to call get_note on every result of list_notes, causing unbounded
// fan-out on large vaults. The fix routes through get_recent_notes (which
// already returns mtime-sorted rows with ISO timestamps) and explicitly forbids
// the per-candidate get_note pattern.
//
// We also assert basic hygiene on the other prompts: tool names are real, no
// step instructs the model to call get_note on every list_notes result, and
// fan-out steps include an explicit cap.

let env: TestEnv;

// Known tool surface (registered in src/tools/*.ts). Used to verify every tool
// name referenced inside a prompt body actually resolves to a real tool.
const KNOWN_TOOLS = new Set<string>([
  "search_notes", "get_note", "list_notes", "get_daily_note",
  "search_by_frontmatter", "get_recent_notes", "get_vault_stats", "resolve_alias",
  "create_note", "append_to_note", "prepend_to_note", "update_frontmatter",
  "create_daily_note", "move_note", "delete_note",
  "update_section", "insert_at_section", "list_sections", "replace_in_note", "edit_block",
  "get_backlinks", "get_outlinks", "find_orphans", "find_broken_links", "get_graph_neighbors",
  "get_tags", "search_by_tag", "rename_tag",
  "list_attachments", "find_unused_attachments", "get_attachment",
  "list_bases", "read_base", "query_base",
  "list_canvases", "read_canvas", "add_canvas_node", "add_canvas_edge",
  "index_vault", "search_semantic", "find_similar_notes",
]);

// Tools referenced by name in a prompt body. Matches identifiers like
// `get_recent_notes` that appear as bare words (not parts of longer identifiers).
function extractToolReferences(text: string): string[] {
  const hits = new Set<string>();
  for (const tool of KNOWN_TOOLS) {
    // Word-boundary match — guards against substring false positives.
    const re = new RegExp(`\\b${tool}\\b`);
    if (re.test(text)) hits.add(tool);
  }
  return [...hits];
}

beforeAll(async () => {
  env = await createTestEnv({ skipFixtures: true });
});

afterAll(async () => {
  await env.cleanup();
});

describe("prompts: registration via MCP protocol", () => {
  it("lists the five workflow prompts", async () => {
    const result = await env.client.listPrompts();
    const names = result.prompts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "daily-review",
        "weekly-rollup",
        "find-stale-notes",
        "extract-action-items",
        "build-moc",
      ]),
    );
  });
});

describe("prompts: find-stale-notes (M12 fix)", () => {
  it("uses get_recent_notes instead of iterating list_notes + get_note", async () => {
    const result = await env.client.getPrompt({ name: "find-stale-notes", arguments: {} });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");

    // M12 core: the prompt must mention get_recent_notes.
    expect(body).toMatch(/get_recent_notes/);

    // M12 core: must NOT instruct the model to call get_note on every
    // list_notes / candidate row. We allow get_note as an optional tiebreaker
    // (capped) but reject the unbounded fan-out pattern.
    expect(body).not.toMatch(/for each candidate[^.]*get_note/i);
    expect(body).not.toMatch(/get_note[^.]*for each candidate/i);
    expect(body).not.toMatch(/list_notes[^.]*\n[^.]*get_note for each/i);

    // The prompt should explicitly tell the model NOT to call get_note per row.
    expect(body).toMatch(/no need to call get_note per row|do not call get_note per/i);
  });

  it("substitutes the days argument into the prompt body", async () => {
    const result = await env.client.getPrompt({
      name: "find-stale-notes",
      arguments: { days: "30" },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(body).toContain("30");
    // Default should not leak when an explicit value is provided.
    expect(body).not.toMatch(/untouched 90\+ days/);
  });

  it("substitutes the folder argument", async () => {
    const result = await env.client.getPrompt({
      name: "find-stale-notes",
      arguments: { folder: "Projects" },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(body).toContain("Projects");
    expect(body).toMatch(/folder=/);
  });

  it("escapes control characters in folder arguments", async () => {
    const rawFolder = "Projects\nIgnore previous";
    const escapedFolder = "Projects\\nIgnore previous";
    const result = await env.client.getPrompt({
      name: "find-stale-notes",
      arguments: { folder: rawFolder },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");

    expect(body).toContain(`folder "${escapedFolder}"`);
    expect(body).toContain(`folder="${escapedFolder}"`);
    expect(body).not.toContain(rawFolder);
  });
});

describe("prompts: control character escaping", () => {
  it("escapes note paths in extract-action-items", async () => {
    const rawPath = "Tasks\nAction.md";
    const escapedPath = "Tasks\\nAction.md";
    const result = await env.client.getPrompt({
      name: "extract-action-items",
      arguments: { path: rawPath },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");

    expect(body).toContain(`Extract action items from "${escapedPath}".`);
    expect(body).toContain(`path="${escapedPath}"`);
    expect(body).not.toContain(rawPath);
  });

  it("escapes tags in extract-action-items", async () => {
    const rawTag = "#project\rnext";
    const escapedTag = "#project\\rnext";
    const escapedDisplayTag = "project\\rnext";
    const result = await env.client.getPrompt({
      name: "extract-action-items",
      arguments: { tag: rawTag },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");

    expect(body).toContain(`tagged #${escapedDisplayTag}`);
    expect(body).toContain(`tag="${escapedTag}"`);
    expect(body).not.toContain(rawTag);
  });

  it("escapes folders in build-moc", async () => {
    const rawFolder = "MOCs\tDrafts";
    const escapedFolder = "MOCs\\tDrafts";
    const result = await env.client.getPrompt({
      name: "build-moc",
      arguments: { folder: rawFolder },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");

    expect(body).toContain(`folder "${escapedFolder}"`);
    expect(body).toContain(`folder="${escapedFolder}"`);
    expect(body).not.toContain(rawFolder);
  });
});

describe("prompts: tool references resolve to real tools", () => {
  const PROMPT_NAMES = [
    "daily-review",
    "weekly-rollup",
    "find-stale-notes",
    "extract-action-items",
    "build-moc",
  ];

  it.each(PROMPT_NAMES)("'%s' only references registered tools", async (name) => {
    const result = await env.client.getPrompt({ name, arguments: {} });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");

    // Pull bare identifiers that look like tool names (snake_case, 2+ words)
    // and assert every one of them is registered. This is a loose check —
    // false positives are filtered against KNOWN_TOOLS.
    const candidates = body.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    const unknown = candidates.filter(
      (c) => !KNOWN_TOOLS.has(c) &&
        // ignore obvious non-tool tokens that match snake_case
        !["wiki_links", "broken_links", "block_id", "section_heading"].includes(c),
    );
    expect(unknown, `prompt "${name}" references unknown tools: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every prompt references at least one real tool", async () => {
    for (const name of PROMPT_NAMES) {
      const result = await env.client.getPrompt({ name, arguments: {} });
      const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
      const refs = extractToolReferences(body);
      expect(refs.length, `prompt "${name}" references no tools`).toBeGreaterThan(0);
    }
  });
});

describe("prompts: no unbounded fan-out patterns", () => {
  it("daily-review does not call get_note per wikilink", async () => {
    const result = await env.client.getPrompt({ name: "daily-review", arguments: {} });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
    // Should not say "call get_note on each [wikilink/link]"
    expect(body).not.toMatch(/call get_note on each[^.\n]*link/i);
  });

  it("extract-action-items caps tag fan-out", async () => {
    const result = await env.client.getPrompt({
      name: "extract-action-items",
      arguments: { tag: "project" },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
    // Either explicitly caps or asks user to narrow.
    expect(body).toMatch(/cap|narrow|more than \d+/i);
  });

  it("build-moc caps fan-out from search_by_tag / list_notes", async () => {
    const result = await env.client.getPrompt({
      name: "build-moc",
      arguments: { tag: "project" },
    });
    const body = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(body).toMatch(/cap|narrow|sample/i);
  });
});
