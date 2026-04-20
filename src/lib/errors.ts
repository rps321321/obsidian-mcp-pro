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
 * client. Strips absolute paths, stack traces, and collapses known errno
 * codes to generic human-readable text.
 */
export function sanitizeError(err: unknown): string {
  if (typeof err === "string") return stripPaths(err);
  if (!err || typeof err !== "object") return "Unknown error";

  const e = err as ErrnoLike;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && FS_ERROR_MESSAGES[code]) return FS_ERROR_MESSAGES[code];

  const msg = typeof e.message === "string" ? e.message : String(err);
  return stripPaths(msg);
}

// Replace anything that looks like an absolute path with `<path>`. Covers:
//   - POSIX: starts with `/` followed by a non-space char
//   - Windows: `C:\…` or `C:/…`
//   - Quoted paths in fs error messages: `'…'`
function stripPaths(s: string): string {
  return s
    .replace(/'[^']*[\\/][^']*'/g, "<path>")
    .replace(/\b[a-zA-Z]:[\\/][^\s'"]+/g, "<path>")
    .replace(/(^|\s)\/[^\s'"]+/g, "$1<path>");
}
