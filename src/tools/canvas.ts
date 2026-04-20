import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCanvasFiles, readCanvasFile, updateCanvasFile, resolveVaultPath } from "../lib/vault.js";
import { sanitizeError } from "../lib/errors.js";
import type { CanvasNode, CanvasData } from "../types.js";
import { randomUUID } from "crypto";

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
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

        const formatted = files.map((f, i) => `${i + 1}. ${f}`).join("\n");
        return {
          content: [{ type: "text" as const, text: `Found ${files.length} canvas file(s):\n\n${formatted}` }],
        };
      } catch (err) {
        console.error("Failed to list canvas files:", err);
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
          .describe("Relative path from vault root to the .canvas file (e.g., 'boards/roadmap.canvas')"),
      },
    },
    async ({ path: canvasPath }) => {
      try {
        const data = await readCanvasFile(vaultPath, canvasPath);
        const lines: string[] = [];

        lines.push(`Canvas: ${canvasPath}`);
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

            lines.push(`  [${node.id}] type=${node.type} pos=${pos} size=${size}`);
            if (preview) {
              lines.push(`    content: ${preview}`);
            }
            if (node.color) {
              lines.push(`    color: ${node.color}`);
            }
          }
          lines.push("");
        }

        if (data.edges.length > 0) {
          lines.push("--- Edges ---");
          for (const edge of data.edges) {
            const label = edge.label ? ` [${edge.label}]` : "";
            const sides = [
              edge.fromSide ? `from-side=${edge.fromSide}` : "",
              edge.toSide ? `to-side=${edge.toSide}` : "",
            ].filter(Boolean).join(" ");
            const sideInfo = sides ? ` (${sides})` : "";
            lines.push(`  ${edge.fromNode} -> ${edge.toNode}${label}${sideInfo}`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        console.error("Failed to read canvas:", err);
        return errorResult(`Error reading canvas: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "add_canvas_node",
    {
      title: "Add Canvas Node",
      description:
        "Add a new node to an Obsidian canvas and persist the updated file. Supports four node types: 'text' (markdown block), 'file' (embedded vault note reference), 'link' (external URL), and 'group' (labeled container). Returns the generated node UUID, needed to connect nodes via add_canvas_edge.",
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
          .describe("Relative path from vault root to the target .canvas file"),
        type: z
          .enum(["text", "file", "link", "group"])
          .describe("Node kind: 'text' = markdown block, 'file' = vault note reference, 'link' = external URL, 'group' = labeled container"),
        content: z
          .string()
          .describe("Interpretation depends on type: text body for 'text', relative note path for 'file', URL for 'link', display label for 'group'"),
        x: z
          .number()
          .optional()
          .default(0)
          .describe("X coordinate on the canvas (default: 0)"),
        y: z
          .number()
          .optional()
          .default(0)
          .describe("Y coordinate on the canvas (default: 0)"),
        width: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(250)
          .describe("Node width in pixels (default: 250)"),
        height: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(60)
          .describe("Node height in pixels (default: 60)"),
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

        const node: CanvasNode = {
          id,
          type,
          x,
          y,
          width,
          height,
        };

        if (type === "text") {
          node.text = content;
        } else if (type === "file") {
          // Validate the file reference stays inside the vault. Without this
          // check, arbitrary paths (e.g. "../../etc/passwd") would be
          // persisted in the canvas JSON and surfaced back to clients.
          try {
            resolveVaultPath(vaultPath, content);
          } catch {
            return errorResult(
              `Invalid file reference: "${content}" must be a relative path inside the vault.`,
            );
          }
          node.file = content;
        } else if (type === "link") {
          node.url = content;
        } else if (type === "group") {
          node.label = content;
        }

        if (color) {
          node.color = color;
        }

        await updateCanvasFile(vaultPath, canvasPath, (data) => {
          data.nodes.push(node);
          return data;
        });

        return {
          content: [{ type: "text" as const, text: `Node added successfully.\nID: ${id}\nType: ${type}\nPosition: (${x}, ${y})` }],
        };
      } catch (err) {
        console.error("Failed to add canvas node:", err);
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
          .describe("Relative path from vault root to the target .canvas file"),
        fromNode: z
          .string()
          .min(1)
          .describe("UUID of the source (origin) node — must already exist on the canvas"),
        toNode: z
          .string()
          .min(1)
          .describe("UUID of the target (destination) node — must already exist on the canvas"),
        label: z
          .string()
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
        const id = randomUUID();
        // Node-existence validated inside the lock to prevent a concurrent
        // deletion from sneaking in between the check and the write.
        class MissingNodeError extends Error {
          constructor(public side: "source" | "target", public nodeId: string) {
            super(`${side} node '${nodeId}' not found in canvas.`);
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
          throw err;
        }

        return {
          content: [{ type: "text" as const, text: `Edge added successfully.\nID: ${id}\nFrom: ${fromNode} -> To: ${toNode}${label ? `\nLabel: ${label}` : ""}` }],
        };
      } catch (err) {
        console.error("Failed to add canvas edge:", err);
        return errorResult(`Error adding edge: ${sanitizeError(err)}`);
      }
    },
  );
}
