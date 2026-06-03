import { escapeControlChars, sanitizeError } from "./errors.js";

export function formatFailedPath(path: string, error: unknown, indent = "  "): string {
  return `${indent}- ${escapeControlChars(path)}: ${sanitizeError(error)}`;
}
