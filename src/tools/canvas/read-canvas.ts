import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openVaultFileForRead, readCanvasFile } from "../../lib/vault.js";
import {
  defineTool,
  richText,
  type RichTextBuilder,
} from "../../lib/tool-seam.js";
import type { CanvasData } from "../../types.js";
import { displayCanvasValue } from "./shared.js";

const CANVAS_READ_CACHE_LIMIT = 16;
const CANVAS_SUMMARY_NODE_LIMIT = 200;
const CANVAS_SUMMARY_EDGE_LIMIT = 200;

interface CanvasReadCacheEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
  data: CanvasData;
}

const canvasReadCache = new Map<string, CanvasReadCacheEntry>();

function canvasReadCacheKey(vaultPath: string, canvasPath: string): string {
  return `${path.resolve(vaultPath)}\0${canvasPath}`;
}

async function getCanvasReadSignature(
  vaultPath: string,
  canvasPath: string
): Promise<{ fullPath: string; size: number; mtimeMs: number }> {
  let opened: Awaited<ReturnType<typeof openVaultFileForRead>> | undefined;
  try {
    opened = await openVaultFileForRead(vaultPath, canvasPath);
    return {
      fullPath: opened.fullPath,
      size: opened.stats.size,
      mtimeMs: opened.stats.mtimeMs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Preserve the existing read_canvas missing-file error shape, which
      // came from readFile rather than stat.
      await readCanvasFile(vaultPath, canvasPath);
    }
    throw err;
  } finally {
    await opened?.handle.close();
  }
}

// Emit the bounded canvas summary through the seam's richText builder. Trusted
// framing goes through `b.trusted`; every vault-derived value (path, node/edge
// identity, content, labels) goes through `b.untrusted`, which BEGIN/END-wraps
// and indents it. Building through the builder is what attaches the block-level
// `read_canvas summary` trust `_meta` — the path section below is unconditional,
// so an untrusted section is always present.
function renderCanvasSummary(
  b: RichTextBuilder,
  canvasPath: string,
  data: CanvasData
): void {
  b.trusted("Canvas:");
  b.untrusted("read_canvas path", displayCanvasValue(canvasPath), "  ");
  b.trusted(`Nodes: ${data.nodes.length} | Edges: ${data.edges.length}`);
  b.trusted("");

  if (data.nodes.length > 0) {
    b.trusted("--- Nodes ---");
    const visibleNodes = data.nodes.slice(0, CANVAS_SUMMARY_NODE_LIMIT);
    for (const node of visibleNodes) {
      const pos = `(${node.x}, ${node.y})`;
      const size = `${node.width}x${node.height}`;
      let preview = "";

      if (node.type === "text" && node.text) {
        preview =
          node.text.length > 100 ? node.text.slice(0, 100) + "..." : node.text;
      } else if (node.type === "file" && node.file) {
        preview = node.file;
      } else if (node.type === "link" && node.url) {
        preview = node.url;
      } else if (node.type === "group" && node.label) {
        preview = `Group: ${node.label}`;
      }

      b.trusted("  Node:");
      b.untrusted(
        "read_canvas node identity",
        `[${displayCanvasValue(node.id)}] type=${displayCanvasValue(node.type)}`,
        "    "
      );
      b.trusted(`    pos=${pos} size=${size}`);
      if (preview) {
        b.trusted("    content:");
        b.untrusted(
          "read_canvas node content",
          displayCanvasValue(preview),
          "      "
        );
      }
      if (node.color) {
        b.trusted("    color:");
        b.untrusted(
          "read_canvas node color",
          displayCanvasValue(node.color),
          "      "
        );
      }
    }
    const omittedNodes = data.nodes.length - visibleNodes.length;
    if (omittedNodes > 0) {
      b.trusted(
        `  ... ${omittedNodes} more node(s) omitted by read_canvas output cap.`
      );
    }
    b.trusted("");
  }

  if (data.edges.length > 0) {
    b.trusted("--- Edges ---");
    const visibleEdges = data.edges.slice(0, CANVAS_SUMMARY_EDGE_LIMIT);
    for (const edge of visibleEdges) {
      const sides = [
        edge.fromSide ? `from-side=${displayCanvasValue(edge.fromSide)}` : "",
        edge.toSide ? `to-side=${displayCanvasValue(edge.toSide)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const sideInfo = sides ? ` (${sides})` : "";
      b.trusted("  Edge:");
      b.untrusted(
        "read_canvas edge endpoints",
        `${displayCanvasValue(edge.fromNode)} -> ${displayCanvasValue(edge.toNode)}${sideInfo}`,
        "    "
      );
      if (edge.label) {
        b.trusted("    label:");
        b.untrusted(
          "read_canvas edge label",
          displayCanvasValue(edge.label),
          "      "
        );
      }
    }
    const omittedEdges = data.edges.length - visibleEdges.length;
    if (omittedEdges > 0) {
      b.trusted(
        `  ... ${omittedEdges} more edge(s) omitted by read_canvas output cap.`
      );
    }
  }
}

// Read-through cache of parsed canvas data, keyed by (vault, path) and validated
// against the file's size+mtime signature. Caching the structured `CanvasData`
// (rather than a rendered string) preserves the file-read/JSON-parse savings
// while letting the summary re-render through the seam each call — the seam is
// the only place that can attach the untrusted-content `_meta`.
async function readCanvasDataCached(
  vaultPath: string,
  canvasPath: string
): Promise<CanvasData> {
  const signature = await getCanvasReadSignature(vaultPath, canvasPath);
  const key = canvasReadCacheKey(vaultPath, canvasPath);
  const cached = canvasReadCache.get(key);
  if (
    cached &&
    cached.fullPath === signature.fullPath &&
    cached.size === signature.size &&
    cached.mtimeMs === signature.mtimeMs
  ) {
    canvasReadCache.delete(key);
    canvasReadCache.set(key, cached);
    return cached.data;
  }

  const data = await readCanvasFile(vaultPath, canvasPath);
  canvasReadCache.set(key, { ...signature, data });
  while (canvasReadCache.size > CANVAS_READ_CACHE_LIMIT) {
    const oldestKey = canvasReadCache.keys().next().value;
    if (oldestKey === undefined) break;
    canvasReadCache.delete(oldestKey);
  }
  return data;
}

export function invalidateCanvasReadCache(
  vaultPath: string,
  canvasPath: string
): void {
  canvasReadCache.delete(canvasReadCacheKey(vaultPath, canvasPath));
}

export function registerReadCanvas(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "read_canvas",
      title: "Read Canvas",
      description:
        "Read an Obsidian canvas file (.canvas, JSON format) and return a bounded human-readable summary of its structure: total node/edge counts, up to 200 nodes with id/type/position/size/content preview, and up to 200 edges with source/target node ids plus optional label. Use to inspect or navigate a canvas before calling add_canvas_node or add_canvas_edge.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .regex(/\.canvas$/i, "Path must end in .canvas")
          .describe(
            "Relative path from vault root to the .canvas file (e.g., 'boards/roadmap.canvas')"
          ),
      },
    },
    async ({ path: canvasPath }, { vaultPath }) => {
      const data = await readCanvasDataCached(vaultPath, canvasPath);
      return richText("read_canvas summary", (b) =>
        renderCanvasSummary(b, canvasPath, data)
      );
    }
  );
}
