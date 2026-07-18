/**
 * Lowest-level vault file-access primitives.
 *
 * Foundation layer: must NOT import from `./vault.js` (or any module that
 * depends on vault). May only import Node built-ins and lower modules
 * (concurrency, permissions, fs-ops, logger, types).
 */
import fs from "fs/promises";
import type { Stats } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { assertAllowed, type AccessKind } from "./permissions.js";
import { renameWithRetry } from "./fs-ops.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Note size guards (single source of truth for mutable caps)
// ---------------------------------------------------------------------------

const MAX_NOTE_FILE_BYTES_DEFAULT = 5 * 1024 * 1024;
const MAX_NOTE_LINE_RANGE_BYTES_DEFAULT = MAX_NOTE_FILE_BYTES_DEFAULT;
let maxNoteFileBytes = MAX_NOTE_FILE_BYTES_DEFAULT;
let maxNoteLineRangeBytes = MAX_NOTE_LINE_RANGE_BYTES_DEFAULT;

export function setMaxNoteFileBytesForTests(bytes: number | null): void {
  maxNoteFileBytes = bytes === null ? MAX_NOTE_FILE_BYTES_DEFAULT : bytes;
}

export function setMaxNoteLineRangeBytesForTests(bytes: number | null): void {
  maxNoteLineRangeBytes =
    bytes === null ? MAX_NOTE_LINE_RANGE_BYTES_DEFAULT : bytes;
}

export function assertNoteFileSize(relativePath: string, size: number): void {
  if (size > maxNoteFileBytes) {
    throw new Error(
      `Note file exceeds size cap (${size} > ${maxNoteFileBytes} bytes): ${relativePath}`
    );
  }
}

export function assertNoteContentSize(
  relativePath: string,
  content: string
): void {
  assertNoteFileSize(relativePath, Buffer.byteLength(content, "utf-8"));
}

export function assertNoteLineRangeBytes(
  relativePath: string,
  size: number
): void {
  if (size > maxNoteLineRangeBytes) {
    throw new Error(
      `Note line fragment exceeds size cap (${size} > ${maxNoteLineRangeBytes} bytes): ${relativePath}`
    );
  }
}

/** Current line-range byte cap (used by streaming note readers). */
export function getMaxNoteLineRangeBytes(): number {
  return maxNoteLineRangeBytes;
}

// ---------------------------------------------------------------------------
// Regular-file asserts
// ---------------------------------------------------------------------------

function assertRegularFile(relativePath: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${relativePath}`);
  }
}

async function assertResolvedRegularFile(
  fullPath: string,
  relativePath: string
): Promise<Stats> {
  const stats = await fs.stat(fullPath);
  assertRegularFile(relativePath, stats);
  return stats;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

// ---------------------------------------------------------------------------
// Path rejection / platform constants
// ---------------------------------------------------------------------------

// Legacy DOS device names reserved by the Windows filesystem at any depth.
// Opening one of these as a file quietly binds to the device (e.g. NUL
// discards writes) rather than creating a real file, which surprises users
// and produces silent data loss. Match case-insensitively against the
// basename WITHOUT extension, since `CON.md`, `con.TXT`, and `LPT1.anything`
// are all reserved on Windows.
const WIN_RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com0",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt0",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** True when running on Windows. Exported for callers that need platform checks. */
export const IS_WIN32 = process.platform === "win32";

/**
 * Directories pruned from vault walks and denied by resolveVaultPath.
 * Exported so listing helpers in vault.ts share the same set.
 */
export const EXCLUDED_DIRS = [".obsidian", ".trash", ".git"];
export const EXCLUDED_SET = new Set(EXCLUDED_DIRS);

// Case-insensitive filesystems (Windows, default macOS) address the same
// inode under different casings — normalize lock keys so `Note.md` and
// `note.md` share one lock.
export const CASE_INSENSITIVE_FS =
  process.platform === "win32" || process.platform === "darwin";

// Per-file serialization for all mutating operations (write/append/prepend/
// delete/move). Without this, concurrent MCP calls on the same file can race
// and lose writes.
const fileLocks = new Map<string, Promise<unknown>>();

export function lockKey(fullPath: string): string {
  return CASE_INSENSITIVE_FS ? fullPath.toLowerCase() : fullPath;
}

function rejectWindowsAlternateDataStreams(relativePath: string): void {
  if (!IS_WIN32) return;
  const badSegment = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .find((seg) => seg.includes(":"));
  if (badSegment) {
    throw new Error(
      `Invalid path: "${badSegment}" uses Windows alternate data stream syntax`
    );
  }
}

function rejectWindowsTraversalSeparators(relativePath: string): void {
  const normalized = path.win32.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.win32.sep}`)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
}

function rejectWindowsTrailingDotOrSpace(relativePath: string): void {
  if (!IS_WIN32) return;
  const badSegment = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .find(
      (seg) =>
        seg !== "" &&
        seg !== "." &&
        seg !== ".." &&
        (seg.endsWith(".") || seg.endsWith(" "))
    );
  if (badSegment) {
    throw new Error(
      `Invalid path: "${badSegment}" ends with a space or period, which Windows normalizes`
    );
  }
}

// Synthetic lock key used to serialize vault-wide bulk-write operations
// (move_note + delete_note with `removeReferences: true`, plus rename_tag
// which scans every note and applies `updateNote` calls). Distinct from
// any real filesystem path because of the `vault-rewrite:` prefix, so it
// never collides with `lockKey(fullPath)`.
//
// Exported so other tools that also do plan-or-scan + per-file-apply over
// the whole vault can serialize against the rewrite path. Without this,
// move_note's `planMoveRewrites` (lockless read of every referrer) can see
// stale bytes shifted by an in-flight `rename_tag`, then `applyRewrites`
// reports those files as `failedReferrers` with "content changed during
// move" and the link is left stale.
export function vaultRewriteLockKey(vaultPath: string): string {
  return `vault-rewrite:${lockKey(path.resolve(vaultPath))}`;
}

/**
 * Crash-atomic file write: stages content to a sibling temp file, then renames
 * onto the target. `fs.rename` is atomic on the same filesystem (POSIX
 * `rename(2)` + Win32 `MoveFileEx` with REPLACE_EXISTING on Node), so readers
 * see either the old content or the new content — never a truncated or
 * partially-written file.
 *
 * Same-directory staging is required: cross-device renames fall back to
 * copy+unlink and lose atomicity. All current callers write inside the vault,
 * so this invariant holds.
 *
 * Callers must serialize themselves via `withFileLock` — the temp-file suffix
 * is random enough to avoid collisions between processes, but atomicity
 * against concurrent writers to the *same* target path still requires the
 * per-path lock (otherwise two concurrent renames race on the final name).
 */
export async function atomicWriteFile(
  fullPath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    // `wx` on the temp file guards against the astronomically unlikely case
    // of a collision with a leftover tmp from a crashed run.
    await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
    await renameWithRetry(tmp, fullPath);
  } catch (err) {
    // Best-effort cleanup: the rename failed (or writeFile did), so the tmp
    // is still on disk. Ignore ENOENT in case writeFile never created it.
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function withFileLock<T>(
  fullPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = lockKey(fullPath);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  // Swallow the prior holder's rejection (so the chain continues) but still
  // run `fn` exactly once via `.then()` — the previous form passed `fn` as
  // both fulfillment and rejection handler, which obscured intent.
  const next = prev.catch(() => undefined).then(fn);
  fileLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveVaultPath(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read"
): string {
  if (!vaultPath) {
    throw new Error("Vault path is not configured");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Invalid path: contains null byte");
  }
  // Reject absolute / drive-relative / UNC inputs explicitly. `path.resolve`
  // on Windows interprets `C:foo` against the current directory of drive C,
  // which can land inside the vault by coincidence and bypass the syntactic
  // prefix check below. Defense-in-depth: the realpath check elsewhere
  // catches the rest, but rejecting these forms up front is cleaner.
  if (
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\")
  ) {
    throw new Error(
      `Invalid path: must be vault-relative, not absolute (${relativePath})`
    );
  }
  rejectWindowsTraversalSeparators(relativePath);
  rejectWindowsAlternateDataStreams(relativePath);
  rejectWindowsTrailingDotOrSpace(relativePath);
  assertAllowed(relativePath, access);
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (
    !resolved.startsWith(resolvedVault + path.sep) &&
    resolved !== resolvedVault
  ) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  // Reject paths that traverse through excluded directories at any depth.
  // `resolveVaultPath` is the single choke point for all file tool calls.
  const rel = path.relative(resolvedVault, resolved).replace(/\\/g, "/");
  const segments = rel ? rel.split("/") : [];
  if (segments.some((seg) => EXCLUDED_SET.has(seg.toLowerCase()))) {
    throw new Error(`Access to excluded directory denied: ${relativePath}`);
  }
  // Reject Windows DOS device names at any segment. Opening `CON.md` / `NUL`
  // on Windows binds to the device and silently discards writes — we fail
  // fast instead so callers see the mistake. Harmless no-op on POSIX.
  if (IS_WIN32) {
    for (const seg of segments) {
      const stem = seg.replace(/\.[^.]*$/, "").toLowerCase();
      if (WIN_RESERVED_BASENAMES.has(stem)) {
        throw new Error(
          `Invalid path: "${seg}" is a reserved Windows device name`
        );
      }
    }
  }
  return resolved;
}

// `path.resolve` strips `..` syntactically but does NOT follow symlinks.
// A symlink inside the vault pointing outside would pass the sync check and
// then leak data through `readFile`. Realpath the deepest existing ancestor
// and re-verify boundary.
// No cache: a single realpath syscall per call is cheap, and caching across
// the process lifetime is unsafe when the library API re-uses the module
// with different vault paths. Stale entries would compare against the wrong
// real root and let symlink escapes through.
export async function getRealVaultRoot(vaultPath: string): Promise<string> {
  const key = path.resolve(vaultPath);
  try {
    return await fs.realpath(key);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT: vault root doesn't exist (yet). Fall back to the resolved path
    // so callers can proceed with creation workflows. Log so the misconfiguration
    // is visible in server logs.
    log.warn("Vault path does not exist, falling back to resolved path", {
      vaultPath: key,
    });
    return key;
  }
}

export async function getVaultRootRealPath(vaultPath: string): Promise<string> {
  return getRealVaultRoot(vaultPath);
}

export async function assertRealPathWithinVault(
  resolved: string,
  vaultPath: string,
  realVaultRoot?: string
): Promise<{ realVault: string; realPath: string }> {
  const realVault = realVaultRoot ?? (await getRealVaultRoot(vaultPath));
  const missing: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const real = await fs.realpath(current);
      const rebuilt =
        missing.length === 0
          ? real
          : path.join(real, ...[...missing].reverse());
      if (rebuilt !== realVault && !rebuilt.startsWith(realVault + path.sep)) {
        throw new Error("Path traversal via symlink detected");
      }
      return { realVault, realPath: rebuilt };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT / ENOTDIR: ancestor doesn't exist yet — climb up to find the
      // deepest existing one. EACCES: an ancestor is permission-restricted
      // (POSIX, typically root-owned). We can't realpath it ourselves, but
      // climbing up is still safe: a higher ancestor that IS readable will
      // canonicalize through any symlinks lower in the chain. We deliberately
      // do NOT rethrow the raw fs error here, which would otherwise leak the
      // absolute path of the restricted ancestor into the error message.
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES")
        throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding any accessible ancestor.
        // Surface a generic message rather than leaking the original error.
        throw new Error("Path traversal check failed", { cause: err });
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function vaultRelativeFromRealPath(
  realVault: string,
  realPath: string
): string {
  const rel = path.relative(realVault, realPath).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

// TOCTOU note: there is a small window between the realpath check in
// `assertRealPathWithinVault` and the caller's actual use of the returned
// path. If a symlink target is swapped by an external process (Obsidian,
// sync client, another shell) in that window, the caller could follow the
// new target without re-validation. This is low-severity because exploiting
// it requires a privileged attacker who can atomically retarget a symlink
// inside the vault during the microsecond gap, and the vault is typically
// local-user-only. Fully closing the window would require holding an open
// fd (O_PATH on Linux, or openat) across all downstream I/O, which Node's
// fs API does not support portably.
export async function resolveVaultPathSafe(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read",
  options?: { realVaultRoot?: string }
): Promise<string> {
  const resolved = resolveVaultPath(vaultPath, relativePath, access);
  const canonical = await assertRealPathWithinVault(
    resolved,
    vaultPath,
    options?.realVaultRoot
  );
  assertAllowed(
    vaultRelativeFromRealPath(canonical.realVault, canonical.realPath),
    access
  );
  return resolved;
}

export interface ValidatedVaultFile {
  fullPath: string;
  handle: FileHandle;
  stats: Stats;
}

export async function openResolvedVaultFileForRead(
  vaultPath: string,
  relativePath: string,
  fullPath: string,
  access: AccessKind | null,
  options?: { realVaultRoot?: string }
): Promise<ValidatedVaultFile> {
  for (let attempt = 0; attempt < 64; attempt++) {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(fullPath, "r");
      const openedStats = await handle.stat();
      assertRegularFile(relativePath, openedStats);

      const canonical = await assertRealPathWithinVault(
        fullPath,
        vaultPath,
        options?.realVaultRoot
      );
      if (access !== null) {
        assertAllowed(
          vaultRelativeFromRealPath(canonical.realVault, canonical.realPath),
          access
        );
      }

      const currentStats = await assertResolvedRegularFile(
        fullPath,
        relativePath
      );
      if (sameFileIdentity(openedStats, currentStats)) {
        return { fullPath, handle, stats: openedStats };
      }

      await handle.close();
      handle = undefined;
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    } catch (err) {
      await handle?.close();
      throw err;
    }
  }

  throw new Error(`Path changed during validation: ${relativePath}`);
}

export async function openVaultFileForRead(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read",
  options?: { realVaultRoot?: string }
): Promise<ValidatedVaultFile> {
  const fullPath = await resolveVaultPathSafe(
    vaultPath,
    relativePath,
    access,
    options
  );
  return openResolvedVaultFileForRead(
    vaultPath,
    relativePath,
    fullPath,
    access,
    options
  );
}

export async function readVaultTextFile(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read",
  options?: { realVaultRoot?: string }
): Promise<{ fullPath: string; stats: Stats; content: string }> {
  const { fullPath, handle, stats } = await openVaultFileForRead(
    vaultPath,
    relativePath,
    access,
    options
  );
  try {
    return { fullPath, stats, content: await handle.readFile("utf-8") };
  } finally {
    await handle.close();
  }
}

export async function resolveVaultInternalPathSafe(
  vaultPath: string,
  relativePath: string
): Promise<string> {
  if (!vaultPath) {
    throw new Error("Vault path is not configured");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Invalid path: contains null byte");
  }
  if (
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\")
  ) {
    throw new Error(
      `Invalid path: must be vault-relative, not absolute (${relativePath})`
    );
  }
  rejectWindowsTraversalSeparators(relativePath);
  rejectWindowsAlternateDataStreams(relativePath);
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (
    !resolved.startsWith(resolvedVault + path.sep) &&
    resolved !== resolvedVault
  ) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  await assertRealPathWithinVault(resolved, vaultPath);
  return resolved;
}

export async function openVaultInternalFileForRead(
  vaultPath: string,
  relativePath: string
): Promise<ValidatedVaultFile> {
  const fullPath = await resolveVaultInternalPathSafe(vaultPath, relativePath);
  return openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, null);
}
