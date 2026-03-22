import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCanvasFiles, readCanvasFile, writeCanvasFile } from "../lib/vault.js";
import type { CanvasNode, CanvasData } from "../types.js";
import { randomUUID } from "crypto";

export function registerCanvasTools(server: McpServer, vaultPath: string): void {
  server.tool(
    "list_canvases",
    "List all canvas files in the vault",
    {},
    async () => {
      try {
        const files = await listCanvasFiles(vaultPath);

        if (files.length === 0) {
          return { content: [{ type: "text", text: "No canvas files found in the vault." }] };
        }

        const formatted = files.map((f, i) => `${i + 1}. ${f}`).join("\n");
        return {
          content: [{ type: "text", text: `Found ${files.length} canvas file(s):\n\n${formatted}` }],
        };
      } catch (err) {
        console.error("Failed to list canvas files:", err);
        return {
          content: [{ type: "text", text: `Error listing canvas files: ${(err as Error).message}` }],
        };
      }
    },
  );

  server.tool(
    "read_canvas",
    "Read and display the contents of an Obsidian canvas file",
    { path: z.string().describe("Relative path to the .canvas file") },
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

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        console.error("Failed to read canvas:", err);
        return {
          content: [{ type: "text", text: `Error reading canvas: ${(err as Error).message}` }],
        };
      }
    },
  );

  server.tool(
    "add_canvas_node",
    "Add a new node to an Obsidian canvas",
    {
      canvasPath: z.string().describe("Relative path to the .canvas file"),
      type: z.enum(["text", "file", "link"]).describe("Node type"),
      content: z.string().describe("Text content, file path, or URL depending on type"),
      x: z.number().optional().default(0).describe("X position"),
      y: z.number().optional().default(0).describe("Y position"),
      width: z.number().optional().default(250).describe("Node width"),
      height: z.number().optional().default(60).describe("Node height"),
      color: z.string().optional().describe("Color: '1'-'6' for Obsidian palette, or hex"),
    },
    async ({ canvasPath, type, content, x, y, width, height, color }) => {
      try {
        const data = await readCanvasFile(vaultPath, canvasPath);
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
          node.file = content;
        } else if (type === "link") {
          node.url = content;
        }

        if (color) {
          node.color = color;
        }

        data.nodes.push(node);
        await writeCanvasFile(vaultPath, canvasPath, data);

        return {
          content: [{ type: "text", text: `Node added successfully.\nID: ${id}\nType: ${type}\nPosition: (${x}, ${y})` }],
        };
      } catch (err) {
        console.error("Failed to add canvas node:", err);
        return {
          content: [{ type: "text", text: `Error adding node: ${(err as Error).message}` }],
        };
      }
    },
  );

  server.tool(
    "add_canvas_edge",
    "Add an edge (connection) between two nodes in a canvas",
    {
      canvasPath: z.string().describe("Relative path to the .canvas file"),
      fromNode: z.string().describe("Source node ID"),
      toNode: z.string().describe("Target node ID"),
      label: z.string().optional().describe("Edge label"),
      fromSide: z.enum(["top", "right", "bottom", "left"]).optional().describe("Side of source node"),
      toSide: z.enum(["top", "right", "bottom", "left"]).optional().describe("Side of target node"),
    },
    async ({ canvasPath, fromNode, toNode, label, fromSide, toSide }) => {
      try {
        const data = await readCanvasFile(vaultPath, canvasPath);

        const fromExists = data.nodes.some((n) => n.id === fromNode);
        const toExists = data.nodes.some((n) => n.id === toNode);

        if (!fromExists) {
          return {
            content: [{ type: "text", text: `Error: source node '${fromNode}' not found in canvas.` }],
          };
        }
        if (!toExists) {
          return {
            content: [{ type: "text", text: `Error: target node '${toNode}' not found in canvas.` }],
          };
        }

        const id = randomUUID();
        const edge: CanvasData["edges"][number] = {
          id,
          fromNode,
          toNode,
        };

        if (label) edge.label = label;
        if (fromSide) edge.fromSide = fromSide;
        if (toSide) edge.toSide = toSide;

        data.edges.push(edge);
        await writeCanvasFile(vaultPath, canvasPath, data);

        return {
          content: [{ type: "text", text: `Edge added successfully.\nID: ${id}\nFrom: ${fromNode} -> To: ${toNode}${label ? `\nLabel: ${label}` : ""}` }],
        };
      } catch (err) {
        console.error("Failed to add canvas edge:", err);
        return {
          content: [{ type: "text", text: `Error adding edge: ${(err as Error).message}` }],
        };
      }
    },
  );
}
