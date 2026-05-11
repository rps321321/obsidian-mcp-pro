// Regression coverage for H7 (canvas path schema validation) and the
// LOW-severity stack-at-origin usability fix in `add_canvas_node`.
//
// H7: every `canvasPath` / `path` schema across the canvas tools now requires
// a `.canvas` suffix. Without that guard, `read_canvas` would parse a stray
// markdown or JSON file as canvas data, and `add_canvas_node` /
// `add_canvas_edge` would silently merge a node into the `nodes` array of an
// unrelated `.json` config file (or fail in a confusing way mid-write).
//
// Stack-at-origin: when callers omit BOTH `x` and `y`, successive nodes used
// to pile up at (0, 0). The tool now staggers them by (50 * existing_count,
// 50 * existing_count) so an LLM agent that just keeps calling add_canvas_node
// without coordinates ends up with a readable diagonal layout.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// H7: canvasPath / path must end in `.canvas`
// ---------------------------------------------------------------------------
describe("H7: canvas tools enforce .canvas extension", () => {
  it("read_canvas rejects a markdown path with an error mentioning .canvas", async () => {
    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "note.md" },
    });
    expect(isError(result)).toBe(true);
    // The Zod regex message surfaces verbatim through the SDK's validation
    // pipeline, so the response should mention `.canvas` somewhere.
    expect(textContent(result).toLowerCase()).toContain(".canvas");
  });

  it("read_canvas rejects a JSON config path", async () => {
    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: ".obsidian/daily-notes.json" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result).toLowerCase()).toContain(".canvas");
  });

  it("add_canvas_node refuses to write into a non-canvas JSON file (does NOT corrupt it)", async () => {
    // Capture the on-disk bytes of the JSON config before the call. If the
    // schema fails to fire, the tool would otherwise merge a node into the
    // file's `nodes` array (or worse, replace its contents with canvas JSON).
    const settingsPath = path.join(env.vaultDir, ".obsidian", "daily-notes.json");
    const before = await fs.readFile(settingsPath, "utf-8");

    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: ".obsidian/daily-notes.json",
        type: "text",
        content: "should never land",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result).toLowerCase()).toContain(".canvas");

    const after = await fs.readFile(settingsPath, "utf-8");
    expect(after).toBe(before);
  });

  it("add_canvas_edge rejects a non-canvas path", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "note-a.md",
        fromNode: "n1",
        toNode: "n2",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result).toLowerCase()).toContain(".canvas");
  });

  it("add_canvas_node still accepts a valid .canvas path (fixture sanity check)", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "text",
        content: "valid path",
        x: 100,
        y: 100,
      },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/Node added/);
  });

  it("read_canvas accepts an upper-case .CANVAS suffix (case-insensitive regex)", async () => {
    // Case-insensitive filesystems (Windows, default macOS) tolerate the
    // alternate casing, so the schema should too. Skip the read assertion on
    // case-sensitive Linux where the file truly doesn't exist; the point of
    // this test is just to confirm the schema doesn't block the call.
    await fs.writeFile(
      path.join(env.vaultDir, "upper.CANVAS"),
      JSON.stringify({ nodes: [], edges: [] }),
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "upper.CANVAS" },
    });
    // Either the read succeeded (case-insensitive FS) or it failed for some
    // OTHER reason than the `.canvas` regex. Both are acceptable; what would
    // FAIL the regression is an error mentioning `.canvas` extension.
    if (isError(result)) {
      expect(textContent(result).toLowerCase()).not.toContain("must end in .canvas");
    }
  });
});

// ---------------------------------------------------------------------------
// LOW-#20: auto-stagger when x/y are omitted
// ---------------------------------------------------------------------------
describe("LOW-#20: add_canvas_node auto-staggers defaulted coordinates", () => {
  it("places multiple defaulted nodes at distinct positions instead of stacking at origin", async () => {
    // Start from an empty canvas so the stagger math is predictable. The
    // shared fixture pre-populates two nodes; using a fresh canvas keeps the
    // count -> position mapping easy to assert on.
    await fs.writeFile(
      path.join(env.vaultDir, "empty.canvas"),
      JSON.stringify({ nodes: [], edges: [] }),
      "utf-8",
    );

    for (const label of ["alpha", "beta", "gamma"]) {
      const result = await env.client.callTool({
        name: "add_canvas_node",
        arguments: {
          canvasPath: "empty.canvas",
          type: "text",
          content: label,
        },
      });
      expect(isError(result)).toBe(false);
    }

    const raw = await fs.readFile(path.join(env.vaultDir, "empty.canvas"), "utf-8");
    const canvas = JSON.parse(raw) as { nodes: Array<{ x: number; y: number; text?: string }> };
    expect(canvas.nodes).toHaveLength(3);

    // Each successive defaulted node should sit at (50 * prior_count) on both
    // axes — i.e. (0,0), (50,50), (100,100). The exact values matter less
    // than the fact that no two nodes share coordinates.
    const positions = canvas.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(positions.length);
    expect(canvas.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(canvas.nodes[1]).toMatchObject({ x: 50, y: 50 });
    expect(canvas.nodes[2]).toMatchObject({ x: 100, y: 100 });
  });

  it("honors an explicit (0, 0) when the caller supplies both coordinates", async () => {
    // Documented behavior: any explicit coordinate disables the stagger.
    // A caller asking for (0, 0) twice gets two nodes at (0, 0) — the tool
    // does not second-guess explicit input.
    await fs.writeFile(
      path.join(env.vaultDir, "pinned.canvas"),
      JSON.stringify({ nodes: [], edges: [] }),
      "utf-8",
    );

    for (let i = 0; i < 2; i++) {
      const result = await env.client.callTool({
        name: "add_canvas_node",
        arguments: {
          canvasPath: "pinned.canvas",
          type: "text",
          content: `pinned-${i}`,
          x: 0,
          y: 0,
        },
      });
      expect(isError(result)).toBe(false);
    }

    const raw = await fs.readFile(path.join(env.vaultDir, "pinned.canvas"), "utf-8");
    const canvas = JSON.parse(raw) as { nodes: Array<{ x: number; y: number }> };
    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(canvas.nodes[1]).toMatchObject({ x: 0, y: 0 });
  });

  it("reports the auto-staggered coordinates in the success message", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "msg.canvas"),
      JSON.stringify({
        nodes: [
          { id: "pre", type: "text", x: 0, y: 0, width: 200, height: 100, text: "seed" },
        ],
        edges: [],
      }),
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "msg.canvas",
        type: "text",
        content: "staggered",
      },
    });
    expect(isError(result)).toBe(false);
    // With one existing node, the new defaulted node should land at (50, 50)
    // and that should be the position echoed back to the caller.
    expect(textContent(result)).toContain("Position: (50, 50)");
  });
});
