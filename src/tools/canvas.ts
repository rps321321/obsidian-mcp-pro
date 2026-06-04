import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCanvasFiles, readCanvasFile, updateCanvasFile, resolveVaultPathSafe } from "../lib/vault.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import type { CanvasNode, CanvasData } from "../types.js";

const CANVAS_READ_CACHE_LIMIT = 16;

interface CanvasReadCacheEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
  text: string;
}

const canvasReadCache = new Map<string, CanvasReadCacheEntry>();

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function displayCanvasValue(value: string): string {
  return escapeControlChars(value);
}

function canvasReadCacheKey(vaultPath: string, canvasPath: string): string {
  return `${path.resolve(vaultPath)}\0${canvasPath}`;
}

async function getCanvasReadSignature(
  vaultPath: string,
  canvasPath: string,
): Promise<{ fullPath: string; size: number; mtimeMs: number }> {
  const fullPath = await resolveVaultPathSafe(vaultPath, canvasPath);
  try {
    const stats = await fs.stat(fullPath);
    return { fullPath, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Preserve the existing read_canvas missing-file error shape, which
      // came from readFile rather than stat.
      await readCanvasFile(vaultPath, canvasPath);
    }
    throw err;
  }
}

function renderCanvasSummary(canvasPath: string, data: CanvasData): string {
  const lines: string[] = [];

  lines.push(`Canvas: ${displayCanvasValue(canvasPath)}`);
  lines.push(`Nodes: ${data.nodes.length} | Edges: ${data.edges.length}`);
  lines.push("");

  if (data.nodes.length > 0) {
    lines.push("--- Nodes ---");
    for (const node of data.nodes) {
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

      lines.push(
        `  [${displayCanvasValue(node.id)}] type=${displayCanvasValue(node.type)} pos=${pos} size=${size}`,
      );
      if (preview) {
        lines.push(`    content: ${displayCanvasValue(preview)}`);
      }
      if (node.color) {
        lines.push(`    color: ${displayCanvasValue(node.color)}`);
      }
    }
    lines.push("");
  }

  if (data.edges.length > 0) {
    lines.push("--- Edges ---");
    for (const edge of data.edges) {
      const label = edge.label ? ` [${displayCanvasValue(edge.label)}]` : "";
      const sides = [
        edge.fromSide ? `from-side=${displayCanvasValue(edge.fromSide)}` : "",
        edge.toSide ? `to-side=${displayCanvasValue(edge.toSide)}` : "",
      ].filter(Boolean).join(" ");
      const sideInfo = sides ? ` (${sides})` : "";
      lines.push(
        `  ${displayCanvasValue(edge.fromNode)} -> ${displayCanvasValue(edge.toNode)}${label}${sideInfo}`,
      );
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

function invalidateCanvasReadCache(vaultPath: string, canvasPath: string): void {
  canvasReadCache.delete(canvasReadCacheKey(vaultPath, canvasPath));
}

export function registerCanvasTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_canvases",
    {
      title: "List Canvases",
      description:
        "Enumerate every Obsidian canvas file (.canvas) anywhere in the vault, returning a numbered list of relative paths and the total count. Takes no parameters — scans the entire vault. Use to discover available canvases before calling read_canvas, add_canvas_node, or add_canvas_edge.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const files = await listCanvasFiles(vaultPath);

        if (files.length === 0) {
          return { content: [{ type: "text" as const, text: "No canvas files found in the vault." }] };
        }

        const formatted = files.map((f, i) => `${i + 1}. ${displayCanvasValue(f)}`).join("\n");
        return {
          content: [{ type: "text" as const, text: `Found ${files.length} canvas file(s):\n\n${formatted}` }],
        };
      } catch (err) {
        log.error("list_canvases failed", { tool: "list_canvases", err: err as Error });
        return errorResult(`Error listing canvas files: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "read_canvas",
    {
      title: "Read Canvas",
      description:
        "Read an Obsidian canvas file (.canvas, JSON format) and return a human-readable summary of its structure: every node with id, type, position, size, and content preview, plus every edge with source/target node ids and optional label. Use to inspect or navigate a canvas before calling add_canvas_node or add_canvas_edge.",
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
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        log.error("read_canvas failed", { tool: "read_canvas", err: err as Error });
        return errorResult(`Error reading canvas: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "add_canvas_node",
    {
      title: "Add Canvas Node",
      description:
        "Add a new node to an Obsidian canvas and persist the updated file. Supports four node types: 'text' (markdown block), 'file' (embedded vault note reference), 'link' (external URL), and 'group' (labeled container). Returns the generated node UUID, needed to connect nodes via add_canvas_edge. When neither x nor y is supplied, the new node is auto-positioned at (50 * existing_count, 50 * existing_count) to avoid stacking multiple defaulted nodes at the origin. Supplying an explicit x or y always overrides this stagger.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        canvasPath: z
          .string()
          .min(1)
          .max(500)
          .regex(/\.canvas$/i, "Path must end in .canvas")
          .describe("Relative path from vault root to the target .canvas file"),
        type: z
          .enum(["text", "file", "link", "group"])
          .describe("Node kind: 'text' = markdown block, 'file' = vault note reference, 'link' = external URL, 'group' = labeled container"),
        content: z
          .string()
          .min(1)
          .max(100000)
          .describe("Interpretation depends on type: text body for 'text', relative note path for 'file', URL for 'link', display label for 'group'"),
        x: z
          .number()
          .finite()
          .min(-100000)
          .max(100000)
          .optional()
          .describe("X coordinate on the canvas. When omitted (and y is also omitted) the node is auto-staggered to avoid origin pile-up; an explicit value always wins."),
        y: z
          .number()
          .finite()
          .min(-100000)
          .max(100000)
          .optional()
          .describe("Y coordinate on the canvas. When omitted (and x is also omitted) the node is auto-staggered to avoid origin pile-up; an explicit value always wins."),
        width: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(250)
          .describe("Node width in pixels (default: 250, max: 10000)"),
        height: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(60)
          .describe("Node height in pixels (default: 60, max: 10000)"),
        color: z
          .string()
          .regex(/^([1-6]|#[0-9a-fA-F]{3,8})$/, "color must be '1'-'6' or a hex code like '#ff5555'")
          .optional()
          .describe("Color: '1'-'6' for Obsidian's preset palette (red/orange/yellow/green/cyan/purple), or a hex code like '#ff5555'"),
      },
    },
    async ({ canvasPath, type, content, x, y, width, height, color }) => {
      try {
        const id = randomUUID();
        // Coordinate defaulting happens inside the file lock so that the
        // "existing node count" used for stagger reflects the exact state we
        // are about to mutate (no race with a parallel add_canvas_node).
        const autoStaggerX = x === undefined;
        const autoStaggerY = y === undefined;
        const resolvedWidth = width ?? 250;
        const resolvedHeight = height ?? 60;

        if (type === "file") {
          // Validate the file reference stays inside the vault. Without this
          // check, arbitrary paths (e.g. "../../etc/passwd") would be
          // persisted in the canvas JSON and surfaced back to clients.
          // Use the async variant so symlinked paths that escape the vault
          // (via realpath) are also rejected, matches the defense-in-depth
          // used by every other path-accepting tool. The referenced file
          // need not exist yet; `resolveVaultPathSafe` walks up to the
          // deepest existing ancestor and realpath-checks that.
          try {
            await resolveVaultPathSafe(vaultPath, content);
          } catch {
            return errorResult(
              `Invalid file reference: "${displayCanvasValue(content)}" must be a relative path inside the vault.`,
            );
          }
        }

        if (type === "link") {
          // Reject dangerous URI schemes that could execute code when the
          // canvas is opened in Obsidian or exported to HTML.
          if (/^(javascript|data|vbscript):/i.test(content)) {
            return errorResult(
              `Invalid URL scheme in "${displayCanvasValue(content)}". javascript:, data:, and vbscript: URIs are not allowed.`,
            );
          }
        }

        let finalX = 0;
        let finalY = 0;

        await updateCanvasFile(vaultPath, canvasPath, (data) => {
          // Auto-stagger only when BOTH coordinates are omitted; any explicit
          // value disables the stagger so callers can pin to (0, 0) on purpose.
          if (autoStaggerX && autoStaggerY) {
            const count = data.nodes.length;
            finalX = 50 * count;
            finalY = 50 * count;
          } else {
            finalX = autoStaggerX ? 0 : (x);
            finalY = autoStaggerY ? 0 : (y);
          }

          const node: CanvasNode = {
            id,
            type,
            x: finalX,
            y: finalY,
            width: resolvedWidth,
            height: resolvedHeight,
          };

          if (type === "text") {
            node.text = content;
          } else if (type === "file") {
            node.file = content;
          } else if (type === "link") {
            node.url = content;
          } else if (type === "group") {
            node.label = content;
          }

          if (color) {
            node.color = color;
          }

          data.nodes.push(node);
          return data;
        });
        invalidateCanvasReadCache(vaultPath, canvasPath);

        return {
          content: [{ type: "text" as const, text: `Node added successfully.\nID: ${id}\nType: ${type}\nPosition: (${finalX}, ${finalY})` }],
        };
      } catch (err) {
        log.error("add_canvas_node failed", { tool: "add_canvas_node", err: err as Error });
        return errorResult(`Error adding node: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "add_canvas_edge",
    {
      title: "Add Canvas Edge",
      description:
        "Create a directed edge connecting two existing canvas nodes. Both fromNode and toNode must already exist on the canvas (use read_canvas to list node ids, or capture the id returned by add_canvas_node). Optional fromSide/toSide control which face of each node the edge anchors to. Returns the generated edge UUID.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        canvasPath: z
          .string()
          .min(1)
          .max(500)
          .regex(/\.canvas$/i, "Path must end in .canvas")
          .describe("Relative path from vault root to the target .canvas file"),
        fromNode: z
          .string()
          .min(1)
          .max(200)
          .describe("UUID of the source (origin) node - must already exist on the canvas"),
        toNode: z
          .string()
          .min(1)
          .max(200)
          .describe("UUID of the target (destination) node - must already exist on the canvas"),
        label: z
          .string()
          .max(1000)
          .optional()
          .describe("Optional text label rendered on the edge"),
        fromSide: z
          .enum(["top", "right", "bottom", "left"])
          .optional()
          .describe("Face of the source node the edge leaves from (default: auto-chosen by Obsidian)"),
        toSide: z
          .enum(["top", "right", "bottom", "left"])
          .optional()
          .describe("Face of the target node the edge arrives at (default: auto-chosen by Obsidian)"),
      },
    },
    async ({ canvasPath, fromNode, toNode, label, fromSide, toSide }) => {
      try {
        // BUG-15: Reject self-loops early before touching the canvas file.
        if (fromNode === toNode) {
          return errorResult(
            `Self-loop rejected: fromNode and toNode are the same ('${displayCanvasValue(fromNode)}'). Edges must connect two different nodes.`,
          );
        }

        const id = randomUUID();
        // Node-existence validated inside the lock to prevent a concurrent
        // deletion from sneaking in between the check and the write.
        class MissingNodeError extends Error {
          constructor(public side: "source" | "target", public nodeId: string) {
            super(`${side} node '${displayCanvasValue(nodeId)}' not found in canvas.`);
          }
        }
        class DuplicateEdgeError extends Error {
          constructor(public from: string, public to: string) {
            super(
              `An edge from '${displayCanvasValue(from)}' to '${displayCanvasValue(to)}' already exists on the canvas.`,
            );
          }
        }
        try {
          await updateCanvasFile(vaultPath, canvasPath, (data) => {
            if (!data.nodes.some((n) => n.id === fromNode)) {
              throw new MissingNodeError("source", fromNode);
            }
            if (!data.nodes.some((n) => n.id === toNode)) {
              throw new MissingNodeError("target", toNode);
            }
            // BUG-15: Reject duplicate edges between the same node pair.
            const isDuplicate = data.edges.some(
              (e) => e.fromNode === fromNode && e.toNode === toNode,
            );
            if (isDuplicate) {
              throw new DuplicateEdgeError(fromNode, toNode);
            }
            const edge: CanvasData["edges"][number] = { id, fromNode, toNode };
            if (label) edge.label = label;
            if (fromSide) edge.fromSide = fromSide;
            if (toSide) edge.toSide = toSide;
            data.edges.push(edge);
            return data;
          });
        } catch (err) {
          if (err instanceof MissingNodeError) {
            return errorResult(`Error: ${err.message}`);
          }
          if (err instanceof DuplicateEdgeError) {
            return errorResult(`Error: ${err.message}`);
          }
          throw err;
        }
        invalidateCanvasReadCache(vaultPath, canvasPath);

        return {
          content: [{
            type: "text" as const,
            text: `Edge added successfully.\nID: ${id}\nFrom: ${displayCanvasValue(fromNode)} -> To: ${displayCanvasValue(toNode)}${label ? `\nLabel: ${displayCanvasValue(label)}` : ""}`,
          }],
        };
      } catch (err) {
        log.error("add_canvas_edge failed", { tool: "add_canvas_edge", err: err as Error });
        return errorResult(`Error adding edge: ${sanitizeError(err)}`);
      }
    },
  );
}
