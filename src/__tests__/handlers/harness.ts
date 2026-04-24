// Shared test harness for MCP tool-handler integration tests.
//
// Motivation: tests in the rest of the suite exercise the underlying library
// functions (`writeNote`, `resolveWikilink`, `readCanvasFile`, etc). That's
// correct but leaves a gap — every MCP tool handler also contains its own
// glue logic (JSON argument parsing in `create_note.frontmatter`,
// `ensureMdExtension` across write tools, response shaping with
// `isError: true`, canvas file-reference validation, the entire parallelized
// `search_by_frontmatter` rewrite shipped in 1.5.1). None of that glue has
// coverage.
//
// This harness connects a real `Client` to a real `McpServer` via an
// `InMemoryTransport` pair — no network, no stdio subprocess — so handler
// tests can invoke tools exactly as an MCP client would, assert on the
// wire-visible response, and exercise zod schema validation at the boundary.

import fs from "fs/promises";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../index.js";

export interface TestEnv {
  client: Client;
  vaultDir: string;
  cleanup: () => Promise<void>;
}

export interface CreateTestEnvOptions {
  /** Skip writing the default fixture set — useful for tests that need an
   *  empty vault (e.g. `list_canvases` with no canvases). */
  skipFixtures?: boolean;
  /** Additional fixture files to create (relative path → content). */
  extraFiles?: Record<string, string>;
}

export async function createTestEnv(options: CreateTestEnvOptions = {}): Promise<TestEnv> {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-mcp-handlers-"));
  await fs.mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });

  if (!options.skipFixtures) {
    await writeFixtures(vaultDir);
  }

  if (options.extraFiles) {
    for (const [relPath, content] of Object.entries(options.extraFiles)) {
      const full = path.join(vaultDir, relPath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
    }
  }

  const server = buildMcpServer(vaultDir);
  const client = new Client({ name: "handler-test", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const cleanup = async (): Promise<void> => {
    try { await client.close(); } catch { /* ignore */ }
    await fs.rm(vaultDir, { recursive: true, force: true });
  };

  return { client, vaultDir, cleanup };
}

/**
 * Canonical fixture vault. Every handler test that doesn't opt out via
 * `skipFixtures` sees this exact set — deterministic graph + tag + canvas
 * shape that all read/write/link tests can rely on.
 *
 *   note-a.md         → links to note-b, tags: draft, review, frontmatter: status=active
 *   note-b.md         → links to note-c (display "C"), tag: review, status=done
 *   note-c.md         → no links, no tags
 *   orphan.md         → no links in/out, tag: lonely
 *   broken.md         → links to a non-existent note (for find_broken_links)
 *   nested/note-d.md  → links to note-a, tag: nested/archive
 *   daily/2026-04-24.md  → daily note for a fixed date
 *   boards/test.canvas  → 2 nodes + 1 edge
 *   .obsidian/daily-notes.json → { folder: "daily", format: "YYYY-MM-DD" }
 */
async function writeFixtures(vaultDir: string): Promise<void> {
  const w = async (relPath: string, content: string): Promise<void> => {
    const full = path.join(vaultDir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  };

  await w("note-a.md", `---
status: active
tags:
  - draft
  - review
---
# Note A

Links to [[note-b]]. Follow-up on the review.
#draft #review
`);

  await w("note-b.md", `---
status: done
tags: [review]
---
# Note B

See [[note-c|C]] for the conclusion.
`);

  await w("note-c.md", `# Note C

Standalone conclusion with no links and no tags.
`);

  await w("orphan.md", `---
tags: [lonely]
---
# Orphan

Nothing links here and nothing links out.
`);

  await w("broken.md", `# Broken

This links to [[does-not-exist]] which is not a real note.
`);

  await w("nested/note-d.md", `# Note D

Nested note that references [[note-a]].
#nested/archive
`);

  await w("daily/2026-04-24.md", `# 2026-04-24

Daily note fixture for date-specific tests.
`);

  await w(".obsidian/daily-notes.json", JSON.stringify({
    folder: "daily",
    format: "YYYY-MM-DD",
  }));

  await w("boards/test.canvas", JSON.stringify({
    nodes: [
      { id: "n1", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Hello canvas" },
      { id: "n2", type: "file", x: 300, y: 0, width: 200, height: 100, file: "note-a.md" },
    ],
    edges: [
      { id: "e1", fromNode: "n1", toNode: "n2", label: "refs" },
    ],
  }));
}

/**
 * Extract the first text-content payload from a CallToolResult. Throws if
 * the response has no text content — tests that expect a different content
 * shape should assert directly on `result.content`.
 */
export function textContent(result: { content: unknown[] }): string {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`Expected text content, got: ${JSON.stringify(result.content)}`);
  }
  return first.text;
}

/** True if the tool returned an `isError` flag. */
export function isError(result: { isError?: boolean }): boolean {
  return result.isError === true;
}
