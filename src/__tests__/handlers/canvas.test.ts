import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("canvas handlers — list_canvases", () => {
  it("enumerates every .canvas file in the vault", async () => {
    const result = await env.client.callTool({
      name: "list_canvases",
      arguments: {},
    });
    const text = textContent(result);
    expect(text).toContain("boards/test.canvas");
    expect(text).toMatch(/Found 1 canvas/);
  });
});

describe("canvas handlers — read_canvas", () => {
  it("renders nodes + edges with content previews", async () => {
    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("Canvas: boards/test.canvas");
    expect(text).toMatch(/Nodes: 2 \| Edges: 1/);
    expect(text).toContain("[n1] type=text");
    expect(text).toContain("Hello canvas");
    expect(text).toContain("[n2] type=file");
    expect(text).toContain("note-a.md");
    expect(text).toContain("n1 -> n2 [refs]");
  });

  it("returns isError for a malformed canvas JSON", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "bad.canvas"),
      "{ this is not, valid json",
      "utf-8",
    );
    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "bad.canvas" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/malformed JSON/i);
  });
});

describe("canvas handlers — add_canvas_node", () => {
  it("adds a text node and persists it with a UUID", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "text",
        content: "A new thought",
        x: 500,
        y: 500,
      },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/Node added/);
    // Response includes the generated ID — capture and verify on disk.
    const idMatch = text.match(/ID: ([0-9a-f-]{36})/);
    expect(idMatch).not.toBeNull();

    const canvasRaw = await fs.readFile(
      path.join(env.vaultDir, "boards/test.canvas"),
      "utf-8",
    );
    const canvas = JSON.parse(canvasRaw) as { nodes: Array<{ id: string; text?: string }> };
    expect(canvas.nodes).toHaveLength(3);
    const added = canvas.nodes.find((n) => n.id === idMatch![1]);
    expect(added?.text).toBe("A new thought");
  });

  it("validates file-type references stay inside the vault", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "file",
        content: "../../../etc/passwd",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/Invalid file reference/i);
  });

  it("accepts valid relative file references", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "file",
        content: "note-a.md",
      },
    });
    expect(isError(result)).toBe(false);
  });

  it("rejects color values that don't match the palette regex", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "text",
        content: "x",
        color: "chartreuse",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/validation|color|regex/i);
  });
});

describe("canvas handlers — add_canvas_edge", () => {
  it("connects two existing nodes", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "boards/test.canvas",
        fromNode: "n1",
        toNode: "n2",
        label: "second-edge",
      },
    });
    expect(isError(result)).toBe(false);

    const canvasRaw = await fs.readFile(
      path.join(env.vaultDir, "boards/test.canvas"),
      "utf-8",
    );
    const canvas = JSON.parse(canvasRaw) as {
      edges: Array<{ fromNode: string; toNode: string; label?: string }>;
    };
    expect(canvas.edges).toHaveLength(2);
    expect(canvas.edges.some((e) => e.label === "second-edge")).toBe(true);
  });

  it("returns isError when the source node doesn't exist", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "boards/test.canvas",
        fromNode: "ghost",
        toNode: "n2",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/source node.*ghost.*not found/i);
  });

  it("returns isError when the target node doesn't exist", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "boards/test.canvas",
        fromNode: "n1",
        toNode: "ghost",
      },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/target node.*ghost.*not found/i);
  });
});
