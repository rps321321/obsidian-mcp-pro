import type { RichTextBuilder } from "../../lib/tool-seam.js";
import { escapeControlChars } from "../../lib/errors.js";

// The error/result/trust-wrapping recipe (textResult, untrustedVaultTextResult,
// errorResult) now lives in the tool seam (../../lib/tool-seam.ts): handlers
// return a ToolResult built via `text` / `richText` / `error`, and the seam owns
// error sanitization. What remains here are the semantic group's own constants,
// escaping helper, and builder-based render helpers that emit through richText.

const MISSING_PROVIDER_HINT =
  "Set OBSIDIAN_EMBEDDING_PROVIDER=ollama (default) and run an Ollama server with `ollama pull nomic-embed-text`. " +
  "For OpenAI, set OBSIDIAN_EMBEDDING_PROVIDER=openai and OBSIDIAN_EMBEDDING_API_KEY.";

const INDEX_VAULT_CONFIRMATION = "send-vault-text-to-embedding-provider";
const EMBED_BATCH_SIZE = 16;

function displayHeadingPath(path: readonly string[]): string {
  return path.map(escapeControlChars).join(" / ");
}

/** Append the note path as a wrapped untrusted block. */
function semanticPathBlock(
  b: RichTextBuilder,
  label: string,
  notePath: string,
  indent = "    "
): void {
  b.untrusted(label, escapeControlChars(notePath), indent);
}

/** Append the heading path (joined) as a wrapped untrusted block. */
function semanticHeadingBlock(
  b: RichTextBuilder,
  headingPath: readonly string[]
): void {
  b.untrusted("semantic heading", displayHeadingPath(headingPath), "    ");
}

export {
  MISSING_PROVIDER_HINT,
  INDEX_VAULT_CONFIRMATION,
  EMBED_BATCH_SIZE,
  escapeControlChars,
  displayHeadingPath,
  semanticPathBlock,
  semanticHeadingBlock,
};
