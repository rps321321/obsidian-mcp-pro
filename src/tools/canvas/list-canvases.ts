import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listCanvasFiles } from "../../lib/vault.js";
import { defineTool, text, richText } from "../../lib/tool-seam.js";
import { displayCanvasValue } from "./shared.js";

export function registerListCanvases(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "list_canvases",
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
      const files = await listCanvasFiles(vaultPath);

      if (files.length === 0) {
        return text("No canvas files found in the vault.");
      }

      const formatted = files
        .map((f, i) => `${i + 1}. ${displayCanvasValue(f)}`)
        .join("\n");
      return richText("list_canvases paths", (b) => {
        b.trusted(`Found ${files.length} canvas file(s):`);
        b.trusted("");
        b.untrusted("list_canvases paths", formatted);
      });
    }
  );
}
