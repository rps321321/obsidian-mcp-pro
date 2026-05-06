import path from "path";

/**
 * Folder-scoped read/write allowlist. Configured via env vars:
 *   OBSIDIAN_READ_PATHS   colon-or-comma separated vault-relative folders
 *   OBSIDIAN_WRITE_PATHS  same, but for mutations
 *
 * When a list is unset (or empty), that operation is unrestricted across the
 * whole vault. When set, every read or write must resolve to a path that lies
 * under at least one listed folder. The `.` token (or empty string) means
 * "vault root" and effectively re-enables full access.
 *
 * Path matching is case-insensitive on Windows and macOS to align with the
 * vault's filesystem semantics, and case-sensitive on Linux. Paths are
 * normalized to forward slashes and stripped of leading/trailing separators.
 *
 * Critically: `..` segments are collapsed BEFORE the prefix check. v1.8.0
 * called `assertAllowed` on the raw user-supplied path, then later let
 * `path.resolve` collapse `..` segments. A path like
 * `Allowed/../OtherFolder/note.md` slipped past the prefix check (string
 * starts with `Allowed/`) and resolved to a different folder. The
 * normalization step in `normalizeRel` here closes that gap.
 */

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export type AccessKind = "read" | "write";

export interface PermissionConfig {
  readPaths: readonly string[] | null;
  writePaths: readonly string[] | null;
}

function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw
    .split(/[,:;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map(normalizeFolder);
}

function normalizeFolder(folder: string): string {
  let f = folder.replace(/\\/g, "/").trim();
  while (f.startsWith("/")) f = f.slice(1);
  while (f.endsWith("/")) f = f.slice(0, -1);
  if (f === "." || f === "") return "";
  return f;
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

/**
 * Convert a user-supplied path to a vault-relative form with `..` segments
 * syntactically collapsed. Returns `null` when the input tries to climb
 * above its starting point (i.e. above the vault root) — callers treat this
 * as a hard-deny.
 */
function normalizeRel(input: string): string | null {
  const slashed = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
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
  const r = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
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
  const list_ = list.map((f) => f || "<vault root>").join(", ");
  const rel = normalizeRel(relativePath);
  if (rel === null) {
    throw new Error(
      `Access denied: "${relativePath}" escapes the configured ${envName} allowlist (${list_})`,
    );
  }
  for (const folder of list) {
    if (isUnder(rel, folder)) return;
  }
  throw new Error(
    `Access denied: "${relativePath}" is outside the configured ${envName} allowlist (${list_})`,
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
