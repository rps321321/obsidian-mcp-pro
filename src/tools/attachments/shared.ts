import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";
import { escapeControlChars } from "../../lib/errors.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function textResultWithUntrustedMeta(text: string, label: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Escape control characters in a value before embedding it in a display string. */
const displayAttachmentValue = escapeControlChars;

function untrustedAttachmentBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

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

export {
  textResult,
  textResultWithUntrustedMeta,
  errorResult,
  displayAttachmentValue,
  untrustedAttachmentBlock,
  vaultResourceUri,
  safeResourceMimeType,
};
