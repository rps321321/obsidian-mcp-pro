import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";
import { escapeControlChars } from "../../lib/errors.js";

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function untrustedTextResult(label: string, text: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

export function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Escape control characters before embedding values in Base tool display text. */
export const displayBaseValue = escapeControlChars;

export function untrustedBaseBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}
