import { escapeControlChars } from "../../lib/errors.js";

// The error/result/trust-wrapping recipe (textResult, textResultWithUntrustedMeta,
// errorResult, untrustedAttachmentBlock) now lives in the tool seam
// (../../lib/tool-seam.ts): handlers return a ToolResult built via `text` /
// `richText` / `error` / the media constructors, and the seam owns error
// sanitization. What remains here are the attachment group's own helpers.

/** Escape control characters in a value before embedding it in a display string. */

function vaultResourceUri(relPath: string): string {
  return `vault://${relPath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
}

const ACTIVE_TEXT_MIME_TYPES = new Set([
  "text/html",
  "application/xml",
  "text/xml",
  "text/css",
]);

function safeResourceMimeType(mime: string): string {
  return ACTIVE_TEXT_MIME_TYPES.has(mime.toLowerCase()) ? "text/plain" : mime;
}

export { escapeControlChars, vaultResourceUri, safeResourceMimeType };
