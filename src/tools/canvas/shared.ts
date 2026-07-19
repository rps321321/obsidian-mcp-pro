import { escapeControlChars } from "../../lib/errors.js";

// The error/result/trust-wrapping recipe (errorResult, untrustedCanvasTextResult,
// untrustedCanvasBlock) now lives in the tool seam (../../lib/tool-seam.ts):
// handlers return a ToolResult built via `text` / `richText` / `error`, and the
// seam owns error sanitization. What remains here is the canvas group's own
// escaping helper.

export function displayCanvasValue(value: string): string {
  return escapeControlChars(value);
}
