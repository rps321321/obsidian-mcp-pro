import { escapeControlChars } from "../../lib/errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";

const MISSING_PROVIDER_HINT =
  "Set OBSIDIAN_EMBEDDING_PROVIDER=ollama (default) and run an Ollama server with `ollama pull nomic-embed-text`. " +
  "For OpenAI, set OBSIDIAN_EMBEDDING_PROVIDER=openai and OBSIDIAN_EMBEDDING_API_KEY.";

const INDEX_VAULT_CONFIRMATION = "send-vault-text-to-embedding-provider";
const EMBED_BATCH_SIZE = 16;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function untrustedVaultTextResult(text: string, label: string) {
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

const displaySemanticValue = escapeControlChars;

function displayHeadingPath(path: readonly string[]): string {
  return path.map(displaySemanticValue).join(" / ");
}

function semanticHeadingBlock(headingPath: readonly string[]): string {
  return indentBlock(
    formatUntrustedVaultContent("semantic heading", displayHeadingPath(headingPath)),
    "    ",
  );
}

function semanticPathBlock(label: string, notePath: string, indent = "    "): string {
  return indentBlock(
    formatUntrustedVaultContent(label, displaySemanticValue(notePath)),
    indent,
  );
}

export {
  MISSING_PROVIDER_HINT,
  INDEX_VAULT_CONFIRMATION,
  EMBED_BATCH_SIZE,
  textResult,
  untrustedVaultTextResult,
  errorResult,
  displaySemanticValue,
  displayHeadingPath,
  semanticHeadingBlock,
  semanticPathBlock,
};
