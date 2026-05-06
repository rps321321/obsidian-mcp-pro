// Error-message sanitization helpers.
//
// Node's `fs` errors carry absolute host filesystem paths in their `.message`
// (e.g. `ENOENT: no such file or directory, open '/home/user/vault/note.md'`).
// Forwarding these to MCP clients leaks vault locations and potentially other
// host layout information. `sanitizeError` strips the path and returns a
// short, code-based message suitable for client-facing error payloads.

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

interface ErrnoLike {
  code?: unknown;
  message?: unknown;
}

/**
 * Convert an unknown thrown value into a message safe to return to an MCP
 * client. Strips absolute paths, stack traces, collapses known errno
 * codes to generic human-readable text, and escapes control characters so
 * an attacker-controlled value (e.g. a filename with `\n` in it embedded
 * in an error message) can't break out of its line and inject text into
 * the LLM context.
 */
export function sanitizeError(err: unknown): string {
  if (typeof err === "string") return escapeControlChars(stripPaths(err));
  if (!err || typeof err !== "object") return "Unknown error";

  const e = err as ErrnoLike;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && FS_ERROR_MESSAGES[code]) return FS_ERROR_MESSAGES[code];

  const msg = typeof e.message === "string" ? e.message : String(err);
  return escapeControlChars(stripPaths(msg));
}

/**
 * Escape ASCII control characters (newlines, carriage returns, tabs, NULs,
 * etc.) so an attacker-controlled string interpolated into a multi-line tool
 * response can't break out of its line. `\n` becomes the two literal
 * characters `\` and `n`; other control bytes use `\xHH`. Printable input
 * passes through unchanged.
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
  // The control-char range is the whole point of this function — escape
  // anything below ASCII space plus DEL so log lines can't be smuggled
  // newlines or terminal-control sequences. The eslint rule is right to
  // flag this in general; here it's the explicit intent.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
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
