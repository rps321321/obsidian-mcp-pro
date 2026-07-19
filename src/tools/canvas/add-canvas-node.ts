import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveVaultPathSafe, updateCanvasFile } from "../../lib/vault.js";
import { defineTool, text, error } from "../../lib/tool-seam.js";
import type { CanvasNode } from "../../types.js";
import { displayCanvasValue } from "./shared.js";
import { invalidateCanvasReadCache } from "./read-canvas.js";

const ALLOWED_CANVAS_LINK_PROTOCOLS = new Set(["http:", "https:"]);

function validateCanvasLinkUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return `Invalid URL in "${displayCanvasValue(value)}". Canvas link URLs must be absolute http:// or https:// URLs.`;
  }
  if (!ALLOWED_CANVAS_LINK_PROTOCOLS.has(parsed.protocol)) {
    return `Invalid URL scheme in "${displayCanvasValue(value)}". Only http:// and https:// canvas link URLs are allowed.`;
  }
  if (hasUrlControlChars(value)) {
    return `Invalid URL in "${displayCanvasValue(value)}". Control characters are not allowed in canvas link URLs.`;
  }
  return null;
}

function hasUrlControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function registerAddCanvasNode(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "add_canvas_node",
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
          .describe(
            "Node kind: 'text' = markdown block, 'file' = vault note reference, 'link' = external URL, 'group' = labeled container"
          ),
        content: z
          .string()
          .min(1)
          .max(100000)
          .describe(
            "Interpretation depends on type: text body for 'text', relative note path for 'file', URL for 'link', display label for 'group'"
          ),
        x: z
          .number()
          .finite()
          .min(-100000)
          .max(100000)
          .optional()
          .describe(
            "X coordinate on the canvas. When omitted (and y is also omitted) the node is auto-staggered to avoid origin pile-up; an explicit value always wins."
          ),
        y: z
          .number()
          .finite()
          .min(-100000)
          .max(100000)
          .optional()
          .describe(
            "Y coordinate on the canvas. When omitted (and x is also omitted) the node is auto-staggered to avoid origin pile-up; an explicit value always wins."
          ),
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
          .regex(
            /^([1-6]|#[0-9a-fA-F]{3,8})$/,
            "color must be '1'-'6' or a hex code like '#ff5555'"
          )
          .optional()
          .describe(
            "Color: '1'-'6' for Obsidian's preset palette (red/orange/yellow/green/cyan/purple), or a hex code like '#ff5555'"
          ),
      },
    },
    async (
      { canvasPath, type, content, x, y, width, height, color },
      { vaultPath }
    ) => {
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
          return error(
            `Invalid file reference: "${displayCanvasValue(content)}" must be a relative path inside the vault.`
          );
        }
      }

      if (type === "link") {
        // WHATWG URL parsing normalizes leading spaces and C0 whitespace
        // inside schemes, so check the parsed protocol instead of raw text.
        const invalidUrl = validateCanvasLinkUrl(content);
        if (invalidUrl) return error(invalidUrl);
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
          finalX = autoStaggerX ? 0 : x;
          finalY = autoStaggerY ? 0 : y;
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

      return text(
        `Node added successfully.\nID: ${id}\nType: ${type}\nPosition: (${finalX}, ${finalY})`
      );
    }
  );
}
