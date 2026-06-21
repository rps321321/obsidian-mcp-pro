import { escapeControlChars } from "../../lib/errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function displayCanvasValue(value: string): string {
  return escapeControlChars(value);
}

function untrustedCanvasTextResult(label: string, text: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

function untrustedCanvasBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

export {
  errorResult,
  displayCanvasValue,
  untrustedCanvasTextResult,
  untrustedCanvasBlock,
};
