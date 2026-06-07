import path from "path";

/**
 * Folder-scoped read/write allowlist. Configured via env vars:
 *   OBSIDIAN_READ_PATHS   vault-relative folders, separated by `,`, `:`, or `;`
 *   OBSIDIAN_WRITE_PATHS  same, but for mutations
 *
 * Delimiters: `parseList` splits on any of `,`, `:`, or `;`. The three are
 * accepted for convenience across platforms, but each has a caveat:
 *   - `,` (comma) is the recommended default and works everywhere.
 *   - `:` (colon) is the classic POSIX PATH separator, but it is also a
 *     valid character in POSIX filenames (e.g. a folder literally named
 *     `2024:archive` would be split into two entries `2024` and `archive`).
 *     On Windows `:` is reserved (drive letters), so this is rarely an
 *     issue there. POSIX users with colons in folder names should prefer
 *     `,` to avoid fragmentation.
 *   - `;` (semicolon) is the Windows PATH-style separator and is convenient
 *     on Windows shells where `,` may need quoting. It is reserved in some
 *     POSIX shells as a command separator, so quote the env var when using
 *     `;` from a POSIX shell.
 *
 * When a list is unset (or empty), that operation is unrestricted across the
 * whole vault. When set, every read or write must resolve to a path that lies
 * under at least one listed folder. The `.` token (or empty string) means
 * "vault root" and effectively re-enables full access.
 *
 * Path matching is case-insensitive on Windows and macOS to align with the
 * vault's filesystem semantics, and case-sensitive on Linux. Paths are
 * normalized to forward slashes on Windows and stripped of leading/trailing
 * separators. On POSIX, literal backslashes are kept as filename characters
 * so a root-level file named `public\secret.md` does not match an allowlist
 * entry for the `public/` folder.
 *
 * Critically: `..` segments are collapsed BEFORE the prefix check. v1.8.0
 * called `assertAllowed` on the raw user-supplied path, then later let
 * `path.resolve` collapse `..` segments. A path like
 * `Allowed/../OtherFolder/note.md` slipped past the prefix check (string
 * starts with `Allowed/`) and resolved to a different folder. The
 * normalization step in `normalizeRel` here closes that gap.
 */

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const BACKSLASH_IS_SEPARATOR = process.platform === "win32";

export type AccessKind = "read" | "write";

export interface PermissionConfig {
  readPaths: readonly string[] | null;
  writePaths: readonly string[] | null;
}

function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  // Accept comma, colon, or semicolon as separators. See the file header
  // for caveats: `:` collides with POSIX-legal filenames, `;` collides with
  // POSIX shell syntax. `,` is the safest choice and works everywhere.
  const parts = raw
    .split(/[,:;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map(normalizeFolder);
}

function normalizeFolder(folder: string): string {
  let f = normalizePermissionSeparators(folder).trim();
  while (f.startsWith("/")) f = f.slice(1);
  while (f.endsWith("/")) f = f.slice(0, -1);
  if (f === "." || f === "") return "";
  const normalized = path.posix.normalize(f);
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) return f;
  return normalized.replace(/^\/+|\/+$/g, "");
}

export function loadPermissionsFromEnv(): PermissionConfig {
  return {
    readPaths: parseList(process.env.OBSIDIAN_READ_PATHS),
    writePaths: parseList(process.env.OBSIDIAN_WRITE_PATHS),
  };
}

let active: PermissionConfig = loadPermissionsFromEnv();

export function getPermissions(): PermissionConfig {
  return active;
}

export function setPermissions(config: PermissionConfig): void {
  active = {
    readPaths: config.readPaths ? config.readPaths.map(normalizeFolder) : null,
    writePaths: config.writePaths ? config.writePaths.map(normalizeFolder) : null,
  };
}

function eq(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizePermissionSeparators(input: string): string {
  return BACKSLASH_IS_SEPARATOR ? input.replace(/\\/g, "/") : input;
}

/**
 * Convert a user-supplied path to a vault-relative form with `..` segments
 * syntactically collapsed. Returns `null` when the input tries to climb
 * above its starting point (i.e. above the vault root) — callers treat this
 * as a hard-deny.
 */
function normalizeRel(input: string): string | null {
  const slashed = normalizePermissionSeparators(input).replace(/^\/+|\/+$/g, "");
  if (slashed === "") return "";
  const normalized = path.posix.normalize(slashed);
  // After normalization: `..` or `../...` means the input climbed above the
  // vault root via `..` segments. Reject. (`./x` collapses to `x`; `x/y/..`
  // collapses to `x` and is allowed.)
  if (normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized === ".") return "";
  return normalized.replace(/^\/+|\/+$/g, "");
}

function isUnder(rel: string, folder: string): boolean {
  const r = normalizePermissionSeparators(rel).replace(/^\/+|\/+$/g, "");
  if (folder === "") return true;
  if (eq(r, folder)) return true;
  const prefix = folder + "/";
  if (CASE_INSENSITIVE) return r.toLowerCase().startsWith(prefix.toLowerCase());
  return r.startsWith(prefix);
}

/**
 * Throw an Error if the target relative path is not permitted by the
 * configured allowlist for this access kind. No-op when the allowlist is
 * unset.
 */
export function assertAllowed(relativePath: string, kind: AccessKind): void {
  const list = kind === "read" ? active.readPaths : active.writePaths;
  if (!list || list.length === 0) return;
  const envName = kind === "read" ? "OBSIDIAN_READ_PATHS" : "OBSIDIAN_WRITE_PATHS";
  const rel = normalizeRel(relativePath);
  if (rel === null) {
    throw new Error(
      `Access denied: "${relativePath}" escapes the configured ${envName} allowlist`,
    );
  }
  for (const folder of list) {
    if (isUnder(rel, folder)) return;
  }
  throw new Error(
    `Access denied: "${relativePath}" is outside the configured ${envName} allowlist`,
  );
}

export function describePermissions(): { read: string; write: string } {
  const fmt = (xs: readonly string[] | null): string => {
    if (!xs) return "unrestricted";
    if (xs.length === 0) return "unrestricted";
    return xs.map((f) => f || "<vault root>").join(", ");
  };
  return { read: fmt(active.readPaths), write: fmt(active.writePaths) };
}
