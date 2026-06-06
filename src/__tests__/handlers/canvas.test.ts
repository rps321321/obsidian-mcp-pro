import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";
import { MAX_CANVAS_FILE_BYTES } from "../../lib/vault.js";

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
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const text = textContent(result);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: list_canvases paths]");
    expect(text).toContain("boards/test.canvas");
    expect(text).toMatch(/Found 1 canvas/);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });
});

describe("canvas handlers — read_canvas", () => {
  it("renders nodes + edges with content previews", async () => {
    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    expect(isError(result)).toBe(false);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const text = textContent(result);
    expect(text).toContain("Canvas:");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: read_canvas path]");
    expect(text).toContain("boards/test.canvas");
    expect(text).toMatch(/Nodes: 2 \| Edges: 1/);
    expect(text).toContain("[n1] type=text");
    expect(text).toContain("Hello canvas");
    expect(text).toContain("[n2] type=file");
    expect(text).toContain("note-a.md");
    expect(text).toContain("n1 -> n2");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: canvas edge label: boards/test.canvas#e1]");
    expect(text).toContain("refs");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: canvas node content: boards/test.canvas#n1]");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("serves repeated reads without changing the rendered summary", async () => {
    const first = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    const second = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });

    expect(isError(first)).toBe(false);
    expect(isError(second)).toBe(false);
    expect(textContent(second)).toBe(textContent(first));
  });

  it("refreshes cached summaries after an external canvas edit", async () => {
    const first = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    expect(textContent(first)).toMatch(/Nodes: 2 \| Edges: 1/);

    const canvasPath = path.join(env.vaultDir, "boards/test.canvas");
    await fs.writeFile(
      canvasPath,
      JSON.stringify({
        nodes: [
          { id: "n1", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Hello canvas" },
          { id: "n2", type: "file", x: 300, y: 0, width: 200, height: 100, file: "note-a.md" },
          { id: "n3", type: "text", x: 500, y: 0, width: 200, height: 100, text: "Fresh edit" },
        ],
        edges: [{ id: "e1", fromNode: "n1", toNode: "n2", label: "refs" }],
      }),
      "utf-8",
    );
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(canvasPath, future, future);

    const second = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    const text = textContent(second);
    expect(text).toMatch(/Nodes: 3 \| Edges: 1/);
    expect(text).toContain("Fresh edit");
  });

  it("refreshes cached summaries after canvas tool writes", async () => {
    const first = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    expect(textContent(first)).toMatch(/Nodes: 2 \| Edges: 1/);

    const add = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "text",
        content: "Cached write",
      },
    });
    expect(isError(add)).toBe(false);

    const second = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "boards/test.canvas" },
    });
    const text = textContent(second);
    expect(text).toMatch(/Nodes: 3 \| Edges: 1/);
    expect(text).toContain("Cached write");
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

  it("rejects oversized canvas files before parsing JSON", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "huge.canvas"),
      "x".repeat(MAX_CANVAS_FILE_BYTES + 1),
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "huge.canvas" },
    });

    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toMatch(/Canvas file exceeds size cap/i);
    expect(text).not.toMatch(/malformed JSON/i);
  });

  it("keeps crowded canvas summaries bounded while reporting totals", async () => {
    const nodes = Array.from({ length: 205 }, (_, i) => ({
      id: `n${i}`,
      type: "text",
      x: i,
      y: i,
      width: 120,
      height: 80,
      text: `Node ${i}`,
    }));
    const edges = Array.from({ length: 205 }, (_, i) => ({
      id: `e${i}`,
      fromNode: `n${i % nodes.length}`,
      toNode: `n${(i + 1) % nodes.length}`,
      label: `edge ${i}`,
    }));
    await fs.writeFile(
      path.join(env.vaultDir, "crowded.canvas"),
      JSON.stringify({ nodes, edges }),
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "crowded.canvas" },
    });

    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/Nodes: 205 \| Edges: 205/);
    expect(text).toContain("[n199] type=text");
    expect(text).toContain("edge 199");
    expect(text).toContain("5 more node(s) omitted by read_canvas output cap");
    expect(text).toContain("5 more edge(s) omitted by read_canvas output cap");
    expect(text).not.toContain("[n204] type=text");
    expect(text).not.toContain("edge 204");
  });

  it("escapes control characters in vault-authored canvas output", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "dirty.canvas"),
      JSON.stringify({
        nodes: [
          {
            id: "bad\nnode",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            text: "first\nsecond",
          },
          {
            id: "clean",
            type: "text",
            x: 300,
            y: 0,
            width: 200,
            height: 80,
            text: "clean",
          },
        ],
        edges: [
          {
            id: "edge-1",
            fromNode: "bad\nnode",
            toNode: "clean",
            label: "label\nspoof",
          },
        ],
      }),
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "read_canvas",
      arguments: { path: "dirty.canvas" },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("[bad\\nnode] type=text");
    expect(text).toContain("content:");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: canvas node content: dirty.canvas#bad\\nnode]");
    expect(text).toContain("first\\nsecond");
    expect(text).toContain("bad\\nnode -> clean");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: canvas edge label: dirty.canvas#edge-1]");
    expect(text).toContain("label\\nspoof");
    expect(text).not.toContain("bad\nnode");
    expect(text).not.toContain("label\nspoof");
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

  it("rejects oversized existing canvas files before mutation", async () => {
    const fullPath = path.join(env.vaultDir, "huge.canvas");
    const before = "x".repeat(MAX_CANVAS_FILE_BYTES + 1);
    await fs.writeFile(fullPath, before, "utf-8");

    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "huge.canvas",
        type: "text",
        content: "should not write",
      },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/Canvas file exceeds size cap/i);
    await expect(fs.readFile(fullPath, "utf-8")).resolves.toBe(before);
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

  it("rejects dangerous link URL schemes after URL normalization", async () => {
    const canvasPath = path.join(env.vaultDir, "boards/test.canvas");
    const before = await fs.readFile(canvasPath, "utf-8");

    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "link",
        content: "java\nscript:alert(1)",
      },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/invalid url scheme|javascript/i);

    const after = await fs.readFile(canvasPath, "utf-8");
    expect(after).toBe(before);
  });

  it("accepts ordinary HTTPS link URLs", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "link",
        content: "https://example.com/deep/path?q=1",
      },
    });

    expect(isError(result)).toBe(false);
    const canvasRaw = await fs.readFile(
      path.join(env.vaultDir, "boards/test.canvas"),
      "utf-8",
    );
    const canvas = JSON.parse(canvasRaw) as { nodes: Array<{ url?: string }> };
    expect(canvas.nodes.some((n) => n.url === "https://example.com/deep/path?q=1")).toBe(true);
  });

  it("rejects non-web link URL schemes before persisting", async () => {
    const canvasPath = path.join(env.vaultDir, "boards/test.canvas");
    const before = await fs.readFile(canvasPath, "utf-8");

    for (const content of ["file:///C:/Users/me/secret.txt", "obsidian://open?vault=main"]) {
      const result = await env.client.callTool({
        name: "add_canvas_node",
        arguments: {
          canvasPath: "boards/test.canvas",
          type: "link",
          content,
        },
      });

      expect(isError(result)).toBe(true);
      expect(textContent(result)).toMatch(/only http:\/\/ and https:\/\//i);
    }

    const after = await fs.readFile(canvasPath, "utf-8");
    expect(after).toBe(before);
  });

  it("rejects malformed link URLs before persisting", async () => {
    const canvasPath = path.join(env.vaultDir, "boards/test.canvas");
    const before = await fs.readFile(canvasPath, "utf-8");

    const result = await env.client.callTool({
      name: "add_canvas_node",
      arguments: {
        canvasPath: "boards/test.canvas",
        type: "link",
        content: "example.com/no-scheme",
      },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/absolute http:\/\/ or https:\/\//i);

    const after = await fs.readFile(canvasPath, "utf-8");
    expect(after).toBe(before);
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
    // The fixture already has an edge n1 -> n2, so use the reverse direction
    // to avoid the duplicate-edge validation.
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "boards/test.canvas",
        fromNode: "n2",
        toNode: "n1",
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

  it("escapes control characters in missing-node errors", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "boards/test.canvas",
        fromNode: "ghost\nnode",
        toNode: "n2",
      },
    });
    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toContain("source node 'ghost\\nnode' not found");
    expect(text).not.toContain("ghost\nnode");
  });

  it("escapes control characters in the success message label", async () => {
    const result = await env.client.callTool({
      name: "add_canvas_edge",
      arguments: {
        canvasPath: "boards/test.canvas",
        fromNode: "n2",
        toNode: "n1",
        label: "safe\nlabel",
      },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toContain("Label: safe\\nlabel");
    expect(text).not.toContain("safe\nlabel");
  });
});
