import { escapeControlChars } from "../../lib/errors.js";
import { updateFrontmatter } from "../../lib/markdown.js";

export function textResult(text: string, meta?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text, ...(meta ? { _meta: meta } : {}) }] };
}

export function errorResult(text: string, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text, ...(meta ? { _meta: meta } : {}) }],
    isError: true as const,
  };
}

export const displayWriteValue = escapeControlChars;

export function ensureMdExtension(filePath: string): string {
  return /\.md$/i.test(filePath) ? filePath : `${filePath}.md`;
}

export function buildFrontmatterContent(frontmatterObj: Record<string, unknown>, body: string): string {
  return updateFrontmatter(body, frontmatterObj);
}

// Frontmatter must be a YAML mapping at the root. `JSON.parse` happily returns
// strings, numbers, booleans, null, and arrays as well — feeding any of those
// to `matter.stringify` produces malformed (or surprising) YAML. Reject early
// with a clear message instead of writing a broken file to disk.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
