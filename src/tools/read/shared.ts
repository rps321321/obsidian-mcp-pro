import { escapeControlChars } from "../../lib/errors.js";

// The error/result/trust-wrapping recipe (errorResult, untrustedReadBlock,
// untrustedTextContent) now lives in the tool seam (../../lib/tool-seam.ts):
// handlers return a ToolResult built via `text` / `untrustedText` / `richText`
// / `error`, and the seam owns error sanitization. What remains here are the
// read group's own parsing/escaping helpers.

export { escapeControlChars };

export function frontmatterValueForProperty(
  data: Record<string, unknown>,
  property: string
): unknown {
  if (Object.prototype.hasOwnProperty.call(data, property)) {
    return data[property];
  }
  const requested = property.toLowerCase();
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase() === requested) return value;
  }
  return undefined;
}

export function parseRequestedLine(value: string): number | null {
  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 0) return null;
  return Math.max(1, line);
}

export function parseRequestedLineRange(
  value: string
): { start: number; end: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!m) return null;
  const [, startText, endText] = m;
  if (!startText) return null;
  const start = parseRequestedLine(startText);
  const requestedEnd = endText ? parseRequestedLine(endText) : start;
  if (start === null || requestedEnd === null) return null;
  return { start, end: Math.max(start, requestedEnd) };
}

export function toSearchableString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Parse a `since` filter into milliseconds-since-epoch. Accepts ISO 8601
 * (YYYY-MM-DD or full timestamp) or relative spans of the form `<n><unit>`
 * where unit is `h` (hours), `d` (days), or `w` (weeks). Returns null on
 * unrecognized input so callers can surface a precise error.
 */
export function parseSince(input: string): number | null {
  const trimmed = input.trim();
  // Relative span: 7d, 24h, 2w
  const rel = trimmed.match(/^(\d+)\s*(h|d|w)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms =
      unit === "h" ? 3600_000 : unit === "d" ? 86_400_000 : 7 * 86_400_000;
    return Date.now() - n * ms;
  }
  // ISO date: YYYY-MM-DD or full timestamp.
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}
