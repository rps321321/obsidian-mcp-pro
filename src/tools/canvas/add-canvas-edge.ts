import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateCanvasFile } from "../../lib/vault.js";
import { defineTool, text, error } from "../../lib/tool-seam.js";
import type { CanvasData } from "../../types.js";
import { escapeControlChars } from "./shared.js";
import { invalidateCanvasReadCache } from "./read-canvas.js";

export function registerAddCanvasEdge(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "add_canvas_edge",
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
          .describe(
            "UUID of the source (origin) node - must already exist on the canvas"
          ),
        toNode: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "UUID of the target (destination) node - must already exist on the canvas"
          ),
        label: z
          .string()
          .max(1000)
          .optional()
          .describe("Optional text label rendered on the edge"),
        fromSide: z
          .enum(["top", "right", "bottom", "left"])
          .optional()
          .describe(
            "Face of the source node the edge leaves from (default: auto-chosen by Obsidian)"
          ),
        toSide: z
          .enum(["top", "right", "bottom", "left"])
          .optional()
          .describe(
            "Face of the target node the edge arrives at (default: auto-chosen by Obsidian)"
          ),
      },
    },
    async ({ canvasPath, fromNode, toNode, label, fromSide, toSide }) => {
      // BUG-15: Reject self-loops early before touching the canvas file.
      if (fromNode === toNode) {
        return error(
          `Self-loop rejected: fromNode and toNode are the same ('${escapeControlChars(fromNode)}'). Edges must connect two different nodes.`
        );
      }

      const id = randomUUID();
      // Node-existence validated inside the lock to prevent a concurrent
      // deletion from sneaking in between the check and the write.
      class MissingNodeError extends Error {
        constructor(
          public side: "source" | "target",
          public nodeId: string
        ) {
          super(
            `${side} node '${escapeControlChars(nodeId)}' not found in canvas.`
          );
        }
      }
      class DuplicateEdgeError extends Error {
        constructor(
          public from: string,
          public to: string
        ) {
          super(
            `An edge from '${escapeControlChars(from)}' to '${escapeControlChars(to)}' already exists on the canvas.`
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
            (e) => e.fromNode === fromNode && e.toNode === toNode
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
        // Expected validation failures carry handler-authored (control-char
        // escaped) messages and pass through verbatim. Anything else is
        // unexpected and re-thrown to the seam's single sanitize point.
        if (
          err instanceof MissingNodeError ||
          err instanceof DuplicateEdgeError
        ) {
          return error(`Error: ${err.message}`);
        }
        throw err;
      }
      invalidateCanvasReadCache(vaultPath, canvasPath);

      return text(
        `Edge added successfully.\nID: ${id}\nFrom: ${escapeControlChars(fromNode)} -> To: ${escapeControlChars(toNode)}${label ? `\nLabel: ${escapeControlChars(label)}` : ""}`
      );
    }
  );
}
