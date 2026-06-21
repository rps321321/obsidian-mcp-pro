import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listCanvasFiles } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import {
  errorResult,
  displayCanvasValue,
  untrustedCanvasTextResult,
  untrustedCanvasBlock,
} from "./shared.js";

export function registerListCanvases(server: McpServer, vaultPath: string): void {
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
        return untrustedCanvasTextResult(
          "list_canvases paths",
          `Found ${files.length} canvas file(s):\n\n${untrustedCanvasBlock("list_canvases paths", formatted)}`,
        );
      } catch (err) {
        log.error("list_canvases failed", { tool: "list_canvases", err: err as Error });
        return errorResult(`Error listing canvas files: ${sanitizeError(err)}`);
      }
    },
  );
}
