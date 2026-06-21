import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  openVaultFileForRead,
  readCanvasFile,
} from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { untrustedVaultContentMeta } from "../../lib/tool-output.js";
import { log } from "../../lib/logger.js";
import type { CanvasData } from "../../types.js";
import {
  errorResult,
  displayCanvasValue,
  untrustedCanvasBlock,
} from "./shared.js";
import { indentBlock, formatUntrustedVaultContent } from "../../lib/tool-output.js";

const CANVAS_READ_CACHE_LIMIT = 16;
const CANVAS_SUMMARY_NODE_LIMIT = 200;
const CANVAS_SUMMARY_EDGE_LIMIT = 200;

interface CanvasReadCacheEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
  text: string;
}

const canvasReadCache = new Map<string, CanvasReadCacheEntry>();

function canvasReadCacheKey(vaultPath: string, canvasPath: string): string {
  return `${path.resolve(vaultPath)}\0${canvasPath}`;
}

async function getCanvasReadSignature(
  vaultPath: string,
  canvasPath: string,
): Promise<{ fullPath: string; size: number; mtimeMs: number }> {
  let opened: Awaited<ReturnType<typeof openVaultFileForRead>> | undefined;
  try {
    opened = await openVaultFileForRead(vaultPath, canvasPath);
    return { fullPath: opened.fullPath, size: opened.stats.size, mtimeMs: opened.stats.mtimeMs };
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

function renderCanvasSummary(canvasPath: string, data: CanvasData): string {
  const lines: string[] = [];

  lines.push("Canvas:");
  lines.push(untrustedCanvasBlock("read_canvas path", displayCanvasValue(canvasPath), "  "));
  lines.push(`Nodes: ${data.nodes.length} | Edges: ${data.edges.length}`);
  lines.push("");

  if (data.nodes.length > 0) {
    lines.push("--- Nodes ---");
    const visibleNodes = data.nodes.slice(0, CANVAS_SUMMARY_NODE_LIMIT);
    for (const node of visibleNodes) {
      const pos = `(${node.x}, ${node.y})`;
      const size = `${node.width}x${node.height}`;
      let preview = "";

      if (node.type === "text" && node.text) {
        preview = node.text.length > 100
          ? node.text.slice(0, 100) + "..."
          : node.text;
      } else if (node.type === "file" && node.file) {
        preview = node.file;
      } else if (node.type === "link" && node.url) {
        preview = node.url;
      } else if (node.type === "group" && node.label) {
        preview = `Group: ${node.label}`;
      }

      lines.push("  Node:");
      lines.push(untrustedCanvasBlock(
        "read_canvas node identity",
        `[${displayCanvasValue(node.id)}] type=${displayCanvasValue(node.type)}`,
        "    ",
      ));
      lines.push(`    pos=${pos} size=${size}`);
      if (preview) {
        lines.push("    content:");
        lines.push(indentBlock(
          formatUntrustedVaultContent(
            "read_canvas node content",
            displayCanvasValue(preview),
          ),
          "      ",
        ));
      }
      if (node.color) {
        lines.push("    color:");
        lines.push(untrustedCanvasBlock(
          "read_canvas node color",
          displayCanvasValue(node.color),
          "      ",
        ));
      }
    }
    const omittedNodes = data.nodes.length - visibleNodes.length;
    if (omittedNodes > 0) {
      lines.push(`  ... ${omittedNodes} more node(s) omitted by read_canvas output cap.`);
    }
    lines.push("");
  }

  if (data.edges.length > 0) {
    lines.push("--- Edges ---");
    const visibleEdges = data.edges.slice(0, CANVAS_SUMMARY_EDGE_LIMIT);
    for (const edge of visibleEdges) {
      const sides = [
        edge.fromSide ? `from-side=${displayCanvasValue(edge.fromSide)}` : "",
        edge.toSide ? `to-side=${displayCanvasValue(edge.toSide)}` : "",
      ].filter(Boolean).join(" ");
      const sideInfo = sides ? ` (${sides})` : "";
      lines.push("  Edge:");
      lines.push(untrustedCanvasBlock(
        "read_canvas edge endpoints",
        `${displayCanvasValue(edge.fromNode)} -> ${displayCanvasValue(edge.toNode)}${sideInfo}`,
        "    ",
      ));
      if (edge.label) {
        lines.push("    label:");
        lines.push(indentBlock(
          formatUntrustedVaultContent(
            "read_canvas edge label",
            displayCanvasValue(edge.label),
          ),
          "      ",
        ));
      }
    }
    const omittedEdges = data.edges.length - visibleEdges.length;
    if (omittedEdges > 0) {
      lines.push(`  ... ${omittedEdges} more edge(s) omitted by read_canvas output cap.`);
    }
  }

  return lines.join("\n");
}

async function readCanvasSummaryCached(vaultPath: string, canvasPath: string): Promise<string> {
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
    return cached.text;
  }

  const data = await readCanvasFile(vaultPath, canvasPath);
  const text = renderCanvasSummary(canvasPath, data);
  canvasReadCache.set(key, { ...signature, text });
  while (canvasReadCache.size > CANVAS_READ_CACHE_LIMIT) {
    const oldestKey = canvasReadCache.keys().next().value;
    if (oldestKey === undefined) break;
    canvasReadCache.delete(oldestKey);
  }
  return text;
}

export function invalidateCanvasReadCache(vaultPath: string, canvasPath: string): void {
  canvasReadCache.delete(canvasReadCacheKey(vaultPath, canvasPath));
}

export function registerReadCanvas(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "read_canvas",
    {
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
          .describe("Relative path from vault root to the .canvas file (e.g., 'boards/roadmap.canvas')"),
      },
    },
    async ({ path: canvasPath }) => {
      try {
        const text = await readCanvasSummaryCached(vaultPath, canvasPath);
        return {
          content: [{
            type: "text" as const,
            text,
            _meta: untrustedVaultContentMeta("read_canvas summary"),
          }],
        };
      } catch (err) {
        log.error("read_canvas failed", { tool: "read_canvas", err: err as Error });
        return errorResult(`Error reading canvas: ${sanitizeError(err)}`);
      }
    },
  );
}
