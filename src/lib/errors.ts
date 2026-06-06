// Error-message sanitization helpers.
//
// Node's `fs` errors carry absolute host filesystem paths in their `.message`
// (e.g. `ENOENT: no such file or directory, open '/home/user/vault/note.md'`).
// Forwarding these to MCP clients leaks vault locations and potentially other
// host layout information. Other error paths may also contain secret-bearing
// URLs. `sanitizeError` strips those sensitive details and returns a short,
// code-based message suitable for client-facing error payloads.

const FS_ERROR_MESSAGES: Record<string, string> = {
  ENOENT: "File or directory not found",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EEXIST: "File already exists",
  EISDIR: "Path is a directory",
  ENOTDIR: "Path is not a directory",
  ENOTEMPTY: "Directory is not empty",
  EBUSY: "Resource busy",
  EMFILE: "Too many open files",
  ENAMETOOLONG: "Path is too long",
};

// The ASCII control-char range is the whole point of this regex: escape
// anything below ASCII space plus DEL so log lines can't be smuggled newlines
// or terminal-control sequences. The eslint rule is right to flag this in
// general; here it's the explicit intent.
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_RE = /[\x00-\x1f\x7f]/g;
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

interface ErrnoLike {
  code?: unknown;
  message?: unknown;
}

/**
 * Convert an unknown thrown value into a message safe to return to an MCP
 * client. Strips absolute paths and secret-bearing URLs, collapses known errno
 * codes to generic human-readable text, and escapes control characters so
 * an attacker-controlled value (e.g. a filename with `\n` in it embedded
 * in an error message) can't break out of its line and inject text into
 * the LLM context.
 */
export function sanitizeError(err: unknown): string {
  if (typeof err === "string") return escapeControlChars(stripPaths(redactUrlSecrets(err)));
  if (!err || typeof err !== "object") return "Unknown error";

  const e = err as ErrnoLike;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && FS_ERROR_MESSAGES[code]) return FS_ERROR_MESSAGES[code];

  const msg = typeof e.message === "string" ? e.message : fallbackErrorMessage(err);
  return escapeControlChars(stripPaths(redactUrlSecrets(msg)));
}

function fallbackErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err === null || err === undefined) return "Unknown error";
  try {
    return JSON.stringify(err) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/**
 * Escape ASCII control characters (newlines, carriage returns, tabs, NULs,
 * etc.) and Unicode bidi controls so an attacker-controlled string
 * interpolated into a multi-line tool response can't break out of its line or
 * visually reorder displayed paths/snippets. `\n` becomes the two literal
 * characters `\` and `n`; other control bytes use `\xHH`; bidi controls use
 * `\uHHHH`. Printable input passes through unchanged.
 *
 * Exists as a separate export from `sanitizeError` because that function's
 * path-stripping step would rewrite a path-shaped value to literal `<path>`
 * — fine inside an error message that mentions a host path, but it would
 * erase the value when the value itself is the path you want to display
 * (e.g. `f.path` from `failedReferrers`). Both functions apply the same
 * control-char escape, so passing `f.path` here and `f.error` to
 * `sanitizeError` gives equivalent injection protection through different
 * doors.
 */
export function escapeControlChars(s: string): string {
  return s
    .replace(ASCII_CONTROL_RE, (c) => {
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
    })
    .replace(BIDI_CONTROL_RE, (c) =>
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

const URL_LIKE_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'`]+/g;
const TRAILING_URL_PUNCT_RE = /[)\].,;!?]+$/;

/**
 * Remove credentials and parameter-bearing URL details from client-facing
 * error text. Plain URLs are left alone so ordinary diagnostics stay useful;
 * URLs with userinfo, query strings, or fragments are collapsed because those
 * parts commonly carry API keys, bearer tokens, or internal setup details.
 */
export function redactUrlSecrets(s: string): string {
  return s.replace(URL_LIKE_RE, (candidate) => {
    const trailing = candidate.match(TRAILING_URL_PUNCT_RE)?.[0] ?? "";
    const rawUrl = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      const parsed = new URL(rawUrl);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        return candidate;
      }
      return `${parsed.protocol}//<redacted-url>${trailing}`;
    } catch {
      return `<redacted-url>${trailing}`;
    }
  });
}

// Replace anything that looks like an absolute path with `<path>`. Covers:
//   - POSIX: starts with `/` followed by a non-space char
//   - Windows: `C:\…` or `C:/…`
//   - Quoted paths in fs error messages: `'…'`
//
// Exported (alongside `sanitizeError`) so the logger can apply the same
// stripping to structured log payloads before forwarding them to MCP
// clients via `notifications/message`.
export function stripPaths(s: string): string {
  return s
    .replace(/'[^']*[\\/][^']*'/g, "<path>")
    .replace(/\b[a-zA-Z]:[\\/][^\s'"]+/g, "<path>")
    .replace(/(^|\s)\/[^\s'"]+/g, "$1<path>");
}
