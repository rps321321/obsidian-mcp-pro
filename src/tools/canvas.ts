import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListCanvases } from "./canvas/list-canvases.js";
import { registerReadCanvas } from "./canvas/read-canvas.js";
import { registerAddCanvasNode } from "./canvas/add-canvas-node.js";
import { registerAddCanvasEdge } from "./canvas/add-canvas-edge.js";

export function registerCanvasTools(server: McpServer, vaultPath: string): void {
  registerListCanvases(server, vaultPath);
  registerReadCanvas(server, vaultPath);
  registerAddCanvasNode(server, vaultPath);
  registerAddCanvasEdge(server, vaultPath);
}
