import fs from "fs/promises";
import { constants as fsConstants, type Stats } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { StringDecoder } from "string_decoder";
import { mapConcurrent } from "./concurrency.js";
import { assertAllowed, type AccessKind } from "./permissions.js";
import { renameWithRetry, unlinkWithRetry } from "./fs-ops.js";
import { MAX_BASE_FILE_BYTES } from "./bases.js";
import { log } from "./logger.js";
import type { SearchResult, SearchMatch, CanvasData } from "../types.js";

// Bounded fan-out for vault-wide scans. Higher values saturate the event loop
// on spinning disks; lower values leave SSD throughput on the table. 8 is the
// sweet spot on a typical developer workstation.
const SCAN_CONCURRENCY = 8;
const SEARCH_PATH_MATCH_BOOST = 4;
const SEARCH_HEADING_MATCH_BOOST = 4;
const SEARCH_MATCH_COUNT_WEIGHT = 0.25;
const SEARCH_REPEATED_SAME_LINE_PENALTY = 0.5;
const SEARCH_SNIPPET_MAX_CHARS = 240;
const SEARCH_SNIPPET_OMISSION = "...";
const MAX_NOTE_FILE_BYTES_DEFAULT = 5 * 1024 * 1024;
const MAX_NOTE_LINE_RANGE_BYTES_DEFAULT = MAX_NOTE_FILE_BYTES_DEFAULT;
let maxNoteFileBytes = MAX_NOTE_FILE_BYTES_DEFAULT;
let maxNoteLineRangeBytes = MAX_NOTE_LINE_RANGE_BYTES_DEFAULT;
export const MAX_CANVAS_FILE_BYTES = 1_048_576;
const MAX_CANVAS_NODES = 10_000;
const MAX_CANVAS_EDGES = 20_000;
const COPY_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

const EXCLUDED_DIRS = [".obsidian", ".trash", ".git"];
const EXCLUDED_SET = new Set(EXCLUDED_DIRS);

function assertMarkdownNotePath(relativePath: string): void {
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw new Error(`Not a markdown note: ${relativePath}`);
  }
}

export function setMaxNoteFileBytesForTests(bytes: number | null): void {
  maxNoteFileBytes = bytes === null ? MAX_NOTE_FILE_BYTES_DEFAULT : bytes;
}

export function setMaxNoteLineRangeBytesForTests(bytes: number | null): void {
  maxNoteLineRangeBytes = bytes === null ? MAX_NOTE_LINE_RANGE_BYTES_DEFAULT : bytes;
}

export function assertNoteFileSize(relativePath: string, size: number): void {
  if (size > maxNoteFileBytes) {
    throw new Error(
      `Note file exceeds size cap (${size} > ${maxNoteFileBytes} bytes): ${relativePath}`,
    );
  }
}

function assertRegularFile(relativePath: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${relativePath}`);
  }
}

async function assertResolvedRegularFile(
  fullPath: string,
  relativePath: string,
): Promise<Stats> {
  const stats = await fs.stat(fullPath);
  assertRegularFile(relativePath, stats);
  return stats;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertNoteContentSize(relativePath: string, content: string): void {
  assertNoteFileSize(relativePath, Buffer.byteLength(content, "utf-8"));
}

function assertNoteLineRangeBytes(relativePath: string, size: number): void {
  if (size > maxNoteLineRangeBytes) {
    throw new Error(
      `Note line fragment exceeds size cap (${size} > ${maxNoteLineRangeBytes} bytes): ${relativePath}`,
    );
  }
}

// Legacy DOS device names reserved by the Windows filesystem at any depth.
// Opening one of these as a file quietly binds to the device (e.g. NUL
// discards writes) rather than creating a real file, which surprises users
// and produces silent data loss. Match case-insensitively against the
// basename WITHOUT extension, since `CON.md`, `con.TXT`, and `LPT1.anything`
// are all reserved on Windows.
const WIN_RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const IS_WIN32 = process.platform === "win32";

// Per-file serialization for all mutating operations (write/append/prepend/
// delete/move). Without this, concurrent MCP calls on the same file can race
// and lose writes.
const fileLocks = new Map<string, Promise<unknown>>();
// Case-insensitive filesystems (Windows, default macOS) address the same
// inode under different casings — normalize lock keys so `Note.md` and
// `note.md` share one lock.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
function lockKey(fullPath: string): string {
  return CASE_INSENSITIVE_FS ? fullPath.toLowerCase() : fullPath;
}

function rejectWindowsAlternateDataStreams(relativePath: string): void {
  if (!IS_WIN32) return;
  const badSegment = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .find((seg) => seg.includes(":"));
  if (badSegment) {
    throw new Error(`Invalid path: "${badSegment}" uses Windows alternate data stream syntax`);
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
    .find((seg) =>
      seg !== "" &&
      seg !== "." &&
      seg !== ".." &&
      (seg.endsWith(".") || seg.endsWith(" ")),
    );
  if (badSegment) {
    throw new Error(
      `Invalid path: "${badSegment}" ends with a space or period, which Windows normalizes`,
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
export async function atomicWriteFile(fullPath: string, content: string): Promise<void> {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    // `wx` on the temp file guards against the astronomically unlikely case
    // of a collision with a leftover tmp from a crashed run.
    await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
    await renameWithRetry(tmp, fullPath);
  } catch (err) {
    // Best-effort cleanup: the rename failed (or writeFile did), so the tmp
    // is still on disk. Ignore ENOENT in case writeFile never created it.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

async function removeEmptyExclusivePlaceholder(fullPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile() || stat.size !== 0) return;
    await fs.unlink(fullPath);
  } catch {
    // Best effort only: preserving an unexpected file is safer than deleting
    // something that may have changed after the failed exclusive create.
  }
}

export async function withFileLock<T>(fullPath: string, fn: () => Promise<T>): Promise<T> {
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

/**
 * Walk a directory tree recursively while pruning excluded directories at the
 * traversal level (so `.git`, `.obsidian`, `.trash` subtrees are never read).
 * Returns forward-slash relative paths from `baseDir`.
 */
async function walkVault(
  baseDir: string,
  extensions: string[],
): Promise<string[]> {
  const results: string[] = [];
  const exts = extensions.map((e) => e.toLowerCase());
  await fs.realpath(baseDir);

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const name = entry.name;

      // SEC-11: skip entries whose filename contains a null byte. Some
      // filesystems (or FUSE layers) can surface these; downstream code
      // that passes the name to path.join / fs.open may truncate at the
      // null and operate on a different file.
      if (name.includes('\0')) continue;

      // SEC-1: never traverse symlinks discovered during a vault walk. Direct
      // path reads still use resolveVaultPathSafe; broad listings stay on
      // concrete directory entries and avoid a per-entry lstat syscall.
      const fullEntry = path.join(dir, name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        // Prune excluded directory names at ANY depth. Obsidian's own
        // subfolders aside, nested `.git`/`.obsidian`/`.trash` directories
        // should never be surfaced to clients.
        if (EXCLUDED_SET.has(name.toLowerCase())) continue;
        const nextPrefix = relPrefix === "" ? name : `${relPrefix}/${name}`;
        await walk(fullEntry, nextPrefix);
      } else if (entry.isFile()) {
        const lower = name.toLowerCase();
        if (!exts.some((ext) => lower.endsWith(ext))) continue;
        const relPath = relPrefix === "" ? name : `${relPrefix}/${name}`;
        results.push(relPath);
      }
    }
  }

  await walk(baseDir, "");
  return results;
}

/**
 * Walk every file in the vault, then exclude the listed extensions.
 * Used by attachment listing — Obsidian recognizes anything that isn't a
 * markdown / canvas / base file as an attachment, so it's easier to drop
 * the known text formats than enumerate every binary type a user might
 * paste in.
 */
async function walkVaultExcluding(
  baseDir: string,
  excludedExtensions: string[],
): Promise<string[]> {
  const results: string[] = [];
  const excluded = new Set(excludedExtensions.map((e) => e.toLowerCase()));
  await fs.realpath(baseDir);

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const name = entry.name;

      // SEC-11: skip null-byte filenames (see walkVault for rationale).
      if (name.includes('\0')) continue;

      const fullEntry = path.join(dir, name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (name.startsWith(".")) continue;
        if (EXCLUDED_SET.has(name.toLowerCase())) continue;
        const nextPrefix = relPrefix === "" ? name : `${relPrefix}/${name}`;
        await walk(fullEntry, nextPrefix);
      } else if (entry.isFile()) {
        // Skip dotfiles entirely - `.DS_Store`, `.gitkeep`, editor swap
        // files. They're noise in an attachment listing.
        if (name.startsWith(".")) continue;
        const lower = name.toLowerCase();
        const dotIdx = lower.lastIndexOf(".");
        const ext = dotIdx >= 0 ? lower.slice(dotIdx) : "";
        if (excluded.has(ext)) continue;
        const relPath = relPrefix === "" ? name : `${relPrefix}/${name}`;
        results.push(relPath);
      }
    }
  }

  await walk(baseDir, "");
  return results;
}

export function resolveVaultPath(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read",
): string {
  if (!vaultPath) {
    throw new Error("Vault path is not configured");
  }
  if (relativePath.includes('\0')) {
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
      `Invalid path: must be vault-relative, not absolute (${relativePath})`,
    );
  }
  rejectWindowsTraversalSeparators(relativePath);
  rejectWindowsAlternateDataStreams(relativePath);
  rejectWindowsTrailingDotOrSpace(relativePath);
  assertAllowed(relativePath, access);
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolved.startsWith(resolvedVault + path.sep) && resolved !== resolvedVault) {
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
        throw new Error(`Invalid path: "${seg}" is a reserved Windows device name`);
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
async function getRealVaultRoot(vaultPath: string): Promise<string> {
  const key = path.resolve(vaultPath);
  try {
    return await fs.realpath(key);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT: vault root doesn't exist (yet). Fall back to the resolved path
    // so callers can proceed with creation workflows. Log so the misconfiguration
    // is visible in server logs.
    log.warn("Vault path does not exist, falling back to resolved path", { vaultPath: key });
    return key;
  }
}

export async function getVaultRootRealPath(vaultPath: string): Promise<string> {
  return getRealVaultRoot(vaultPath);
}

async function assertRealPathWithinVault(
  resolved: string,
  vaultPath: string,
  realVaultRoot?: string,
): Promise<{ realVault: string; realPath: string }> {
  const realVault = realVaultRoot ?? await getRealVaultRoot(vaultPath);
  const missing: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const real = await fs.realpath(current);
      const rebuilt = missing.length === 0
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
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw err;
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

function vaultRelativeFromRealPath(realVault: string, realPath: string): string {
  const rel = path.relative(realVault, realPath).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

function isReadAllowed(relativePath: string): boolean {
  try {
    assertAllowed(relativePath, "read");
    return true;
  } catch {
    return false;
  }
}

function filterReadable(entries: string[]): string[] {
  return entries.filter(isReadAllowed);
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
  options?: { realVaultRoot?: string },
): Promise<string> {
  const resolved = resolveVaultPath(vaultPath, relativePath, access);
  const canonical = await assertRealPathWithinVault(resolved, vaultPath, options?.realVaultRoot);
  assertAllowed(vaultRelativeFromRealPath(canonical.realVault, canonical.realPath), access);
  return resolved;
}

export interface ValidatedVaultFile {
  fullPath: string;
  handle: FileHandle;
  stats: Stats;
}

async function openResolvedVaultFileForRead(
  vaultPath: string,
  relativePath: string,
  fullPath: string,
  access: AccessKind | null,
  options?: { realVaultRoot?: string },
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
        options?.realVaultRoot,
      );
      if (access !== null) {
        assertAllowed(vaultRelativeFromRealPath(canonical.realVault, canonical.realPath), access);
      }

      const currentStats = await assertResolvedRegularFile(fullPath, relativePath);
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
  options?: { realVaultRoot?: string },
): Promise<ValidatedVaultFile> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, access, options);
  return openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, access, options);
}

export async function readVaultTextFile(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read",
  options?: { realVaultRoot?: string },
): Promise<{ fullPath: string; stats: Stats; content: string }> {
  const { fullPath, handle, stats } = await openVaultFileForRead(
    vaultPath,
    relativePath,
    access,
    options,
  );
  try {
    return { fullPath, stats, content: await handle.readFile("utf-8") };
  } finally {
    await handle.close();
  }
}

export async function resolveVaultInternalPathSafe(
  vaultPath: string,
  relativePath: string,
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
      `Invalid path: must be vault-relative, not absolute (${relativePath})`,
    );
  }
  rejectWindowsTraversalSeparators(relativePath);
  rejectWindowsAlternateDataStreams(relativePath);
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolved.startsWith(resolvedVault + path.sep) && resolved !== resolvedVault) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  await assertRealPathWithinVault(resolved, vaultPath);
  return resolved;
}

export async function openVaultInternalFileForRead(
  vaultPath: string,
  relativePath: string,
): Promise<ValidatedVaultFile> {
  const fullPath = await resolveVaultInternalPathSafe(vaultPath, relativePath);
  return openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, null);
}

function normalizeListFolder(folder: string | undefined): string {
  if (!folder) return "";
  const slashed = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (slashed === "") return "";
  const normalized = path.posix.normalize(slashed);
  if (normalized === ".") return "";
  return normalized.replace(/^\/+|\/+$/g, "");
}

export async function listNotes(
  vaultPath: string,
  folder?: string,
): Promise<string[]> {
  // Normalize folder before joining and before prefixing returned entries:
  // callers may pass trailing slashes, mixed separators, or dot segments.
  // Returned note paths must stay canonical vault-relative paths.
  const normalizedFolder = normalizeListFolder(folder);

  const baseDir = normalizedFolder
    ? await resolveVaultPathSafe(vaultPath, normalizedFolder)
    : await getRealVaultRoot(vaultPath);

  const entries = await walkVault(baseDir, [".md"]);

  // No `isExcluded` filter needed: `walkVault` already prunes excluded dirs
  // at every traversal level, and `resolveVaultPathSafe` rejects an
  // excluded `folder` argument up front.
  if (!normalizedFolder) return filterReadable(entries).sort();
  return entries.map((rel) => `${normalizedFolder}/${rel}`).sort();
}

export async function readNote(
  vaultPath: string,
  relativePath: string,
): Promise<string> {
  assertMarkdownNotePath(relativePath);
  let handle: FileHandle | undefined;
  try {
    const opened = await openVaultFileForRead(vaultPath, relativePath);
    handle = opened.handle;
    assertNoteFileSize(relativePath, opened.stats.size);
    const content = await handle.readFile("utf-8");
    assertNoteContentSize(relativePath, content);
    return content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Note not found: ${relativePath}`, { cause: err });
    }
    throw err;
  } finally {
    await handle?.close();
  }
}

export interface NoteLineRangeRead {
  text: string;
  pastEndLine?: {
    requested: number;
    total: number;
  };
}

export async function readNoteLineRange(
  vaultPath: string,
  relativePath: string,
  startLine: number,
  endLine: number,
): Promise<NoteLineRangeRead> {
  assertMarkdownNotePath(relativePath);
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new Error(`Invalid line range for note: ${relativePath}`);
  }
  let handle: FileHandle | undefined;
  try {
    const opened = await openVaultFileForRead(vaultPath, relativePath);
    handle = opened.handle;
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const collected: string[] = [];
    let pending = "";
    let currentLine = 1;
    let scannedBytes = 0;
    let outputBytes = 0;

    const processLine = (line: string): boolean => {
      if (currentLine >= startLine && currentLine <= endLine) {
        const lineBytes = Buffer.byteLength(line, "utf-8");
        const separatorBytes = collected.length > 0 ? 1 : 0;
        assertNoteLineRangeBytes(relativePath, outputBytes + separatorBytes + lineBytes);
        outputBytes += separatorBytes + lineBytes;
        collected.push(line);
      }
      const reachedRequestedEnd = currentLine >= endLine;
      currentLine += 1;
      return reachedRequestedEnd;
    };

    while (true) {
      const remainingBytes = maxNoteLineRangeBytes - scannedBytes;
      const bytesToRead = Math.min(buffer.length, Math.max(remainingBytes + 1, 1));
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, null);
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      assertNoteLineRangeBytes(relativePath, scannedBytes);

      let chunk = decoder.write(buffer.subarray(0, bytesRead));
      while (true) {
        const newline = chunk.indexOf("\n");
        if (newline === -1) {
          pending += chunk;
          break;
        }
        const line = pending + chunk.slice(0, newline);
        pending = "";
        if (processLine(line)) {
          return { text: collected.join("\n") };
        }
        chunk = chunk.slice(newline + 1);
      }
    }

    const tail = decoder.end();
    if (tail.length > 0) pending += tail;
    if (processLine(pending)) {
      return { text: collected.join("\n") };
    }

    const totalLines = currentLine - 1;
    if (startLine > totalLines) {
      return { text: "", pastEndLine: { requested: startLine, total: totalLines } };
    }
    return { text: collected.join("\n") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Note not found: ${relativePath}`, { cause: err });
    }
    throw err;
  } finally {
    await handle?.close();
  }
}

export async function writeNote(
  vaultPath: string,
  relativePath: string,
  content: string,
  options?: { exclusive?: boolean },
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  assertNoteContentSize(relativePath, content);
  await withFileLock(fullPath, async () => {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (options?.exclusive) {
      // Exclusivity must survive concurrent writes from *other processes*
      // (Obsidian itself, a second MCP server, a sync client). The in-process
      // lock cannot see them, so rely on the OS: `fs.open` with `wx` is an
      // atomic create-or-fail at the syscall layer. We immediately close the
      // fd — it's a placeholder that reserves the name, and `atomicWriteFile`
      // below replaces the zero-byte file via rename.
      //
      // On case-insensitive filesystems (Windows, default macOS), `wx` on
      // `Note.md` does NOT fail if `note.md` already exists — same inode,
      // different casing. Do an additional case-aware `readdir` check under
      // the per-path lock to cover that specific gap.
      if (CASE_INSENSITIVE_FS) {
        const dir = path.dirname(fullPath);
        const target = path.basename(fullPath).toLowerCase();
        try {
          const entries = await fs.readdir(dir);
          if (entries.some((e) => e.toLowerCase() === target)) {
            const err = new Error(`File already exists: ${relativePath}`) as NodeJS.ErrnoException;
            err.code = "EEXIST";
            throw err;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      let handle: import("fs/promises").FileHandle | undefined;
      try {
        handle = await fs.open(fullPath, "wx");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          const e = new Error(`File already exists: ${relativePath}`) as NodeJS.ErrnoException;
          e.code = "EEXIST";
          throw e;
        }
        throw err;
      } finally {
        await handle?.close();
      }
    }
    try {
      await atomicWriteFile(fullPath, content);
    } catch (err) {
      if (options?.exclusive) await removeEmptyExclusivePlaceholder(fullPath);
      throw err;
    }
  });
}

/**
 * Atomic read-modify-write: reads existing content, applies `transform`, and
 * writes the result while holding the per-file lock for the full sequence.
 * Prevents lost updates when concurrent callers would otherwise read the same
 * base and overwrite each other's changes.
 *
 * Skips the write when the transform returns the existing content unchanged.
 * Without this guard, no-op tools (e.g. `replace_in_note` with zero matches,
 * `rename_tag` on a note that contains no occurrences) would still call
 * `atomicWriteFile`, bumping mtime and invalidating downstream caches
 * (index-cache, embedding-store) for files we didn't actually modify.
 */
export async function updateNote(
  vaultPath: string,
  relativePath: string,
  transform: (existing: string) => string | Promise<string>,
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, "write");
    let existing: string;
    try {
      assertNoteFileSize(relativePath, opened.stats.size);
      existing = await opened.handle.readFile("utf-8");
    } finally {
      await opened.handle.close();
    }
    const next = await transform(existing);
    if (next === existing) return;
    assertNoteContentSize(relativePath, next);
    await atomicWriteFile(fullPath, next);
  });
}

export async function appendToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, "write");
    let existing: string;
    try {
      assertNoteFileSize(relativePath, opened.stats.size);
      existing = await opened.handle.readFile("utf-8");
    } finally {
      await opened.handle.close();
    }
    const separator = existing.endsWith("\n") ? "" : "\n";
    const next = existing + separator + content;
    assertNoteContentSize(relativePath, next);
    await atomicWriteFile(fullPath, next);
  });
}

// Scan for an opening `---\n ... \n---` frontmatter block by walking lines
// and bailing out after a bounded number of lines / bytes. Returns the full
// frontmatter slice (including trailing newline) or null if none exists.
const MAX_FRONTMATTER_LINES = 500;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
function extractLeadingFrontmatter(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return null;
  const afterOpenDelim = content.slice(0, firstNewline + 1);
  // First line must be exactly `---` (allowing optional \r).
  if (afterOpenDelim.replace(/\r?\n$/, "") !== "---") return null;

  let offset = firstNewline + 1;
  let lines = 0;
  while (offset < content.length) {
    if (lines >= MAX_FRONTMATTER_LINES || offset >= MAX_FRONTMATTER_BYTES) return null;
    const nextNewline = content.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const line = content.slice(offset, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      const end = nextNewline === -1 ? content.length : nextNewline + 1;
      return content.slice(0, end);
    }
    if (nextNewline === -1) return null;
    offset = nextNewline + 1;
    lines++;
  }
  return null;
}

export async function prependToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, "write");
    let existing: string;
    try {
      assertNoteFileSize(relativePath, opened.stats.size);
      existing = await opened.handle.readFile("utf-8");
    } finally {
      await opened.handle.close();
    }

    // Detect frontmatter by scanning only the first N lines instead of
    // running a lazy-match regex across the full file. A malformed note with
    // an opening `---` but no closing delimiter would otherwise scan the
    // entire (potentially multi-MB) content and block the event loop.
    const frontmatter = extractLeadingFrontmatter(existing);

    let result: string;
    if (frontmatter) {
      const rest = existing.slice(frontmatter.length);
      const separator = frontmatter.endsWith("\n") ? "" : "\n";
      result = frontmatter + separator + content + "\n" + rest;
    } else {
      result = content + "\n" + existing;
    }

    assertNoteContentSize(relativePath, result);
    await atomicWriteFile(fullPath, result);
  });
}

export interface DeleteNoteOptions {
  /** When false (default), the file moves to `.trash/` and stays recoverable.
   *  When true, the file is permanently unlinked. */
  permanent?: boolean;
  /** When true, also rewrite references across the vault to drop the deleted
   *  file. Wikilinks and markdown links are stripped to their visible text;
   *  embeds (`![[...]]`, `![text](...)`) are removed entirely since they have
   *  no textual fallback. Only honored when `permanent: true` — a file in
   *  `.trash/` is recoverable, so silently editing references would destroy
   *  information the user could otherwise restore. Default false. */
  removeReferences?: boolean;
}

export interface DeleteNoteResult {
  /** Vault-relative paths of files whose references were rewritten. Empty
   *  when `removeReferences` was false or no other note referenced the
   *  deleted file. */
  updatedReferrers: string[];
  /** Per-file failures during the rewrite pass. The deletion has already
   *  committed by the time these are surfaced. */
  failedReferrers: Array<{ path: string; error: string }>;
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.lstat(fullPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function chooseTrashPath(trashFullPath: string): Promise<string> {
  if (!(await pathExists(trashFullPath))) return trashFullPath;

  const parsed = path.parse(trashFullPath);
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const candidate = path.join(parsed.dir, `${parsed.name}.${suffix}${parsed.ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Could not allocate unique trash path for ${path.basename(trashFullPath)}`);
}

async function ensureTrashParentDirectory(
  vaultPath: string,
  trashRoot: string,
  parentDir: string,
): Promise<void> {
  const root = path.resolve(trashRoot);
  const parent = path.resolve(parentDir);
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new Error("Invalid trash path parent");
  }

  const realVault = await getRealVaultRoot(vaultPath);
  const relative = path.relative(root, parent);
  const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  let current = root;

  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    await assertRealPathWithinVault(current, vaultPath, realVault);
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      throw new Error(`Trash path parent is not a directory: ${path.basename(current)}`);
    }
  }
}

export async function deleteNote(
  vaultPath: string,
  relativePath: string,
  options: DeleteNoteOptions = {},
): Promise<DeleteNoteResult> {
  assertMarkdownNotePath(relativePath);
  const permanent = options.permanent === true;
  const removeReferences = permanent && options.removeReferences === true;
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");

  const performDelete = async (): Promise<DeleteNoteResult> => {
    // Build the rewrite plan from the *pre-delete* vault state — resolution
    // must see the file at its current path so wikilinks pointing at it are
    // matched. Only built when removeReferences is on.
    let plan: import("./link-rewriter.js").RewritePlan | null = null;
    if (removeReferences) {
      const { planDeleteRewrites } = await import("./link-rewriter.js");
      const preDeleteNotes = await listNotes(vaultPath);
      plan = await planDeleteRewrites(vaultPath, relativePath, preDeleteNotes);
    }

    await withFileLock(fullPath, async () => {
      if (!permanent) {
        // Build the trash destination by mirroring `resolveVaultPathSafe`'s
        // logic instead of duplicating ad-hoc checks. We can't call
        // `resolveVaultPathSafe(vaultPath, ".trash/" + relativePath)` directly
        // because `.trash` is in EXCLUDED_DIRS and would be rejected up front.
        // What we DO want from that pipeline are: (a) syntactic containment
        // under the vault, and (b) the realpath guard against a symlinked
        // `.trash` (or intermediate dir) pointing outside the vault. The
        // outer `resolveVaultPathSafe(vaultPath, relativePath, "write")` at
        // the top of `deleteNote` already enforced null-byte, traversal, and
        // reserved-name checks on `relativePath`, so it is safe to splice
        // into the `.trash/` prefix here.
        const resolvedVault = path.resolve(vaultPath);
        const trashRoot = path.join(resolvedVault, ".trash");
        const trashFullPath = path.resolve(trashRoot, relativePath);
        if (
          trashFullPath !== trashRoot &&
          !trashFullPath.startsWith(trashRoot + path.sep)
        ) {
          throw new Error(`Invalid trash path: ${relativePath}`);
        }
        await ensureTrashParentDirectory(vaultPath, trashRoot, path.dirname(trashFullPath));
        // Realpath check on the canonical destination: rejects a symlink swap
        // after parent creation but before the rename.
        await assertRealPathWithinVault(trashFullPath, vaultPath);
        const finalTrashPath = await chooseTrashPath(trashFullPath);
        const finalTrashRelPath = path.relative(resolvedVault, finalTrashPath).replace(/\\/g, "/");
        await movePathNoReplace(vaultPath, fullPath, finalTrashPath, finalTrashRelPath);
      } else {
        await fs.unlink(fullPath);
      }
    });

    if (!plan) return { updatedReferrers: [], failedReferrers: [] };

    const { applyRewrites } = await import("./link-rewriter.js");
    const result = await applyRewrites(vaultPath, plan);
    return {
      updatedReferrers: result.updated,
      failedReferrers: result.failed,
    };
  };

  // Same vault-level lock as moveNote when reference rewriting is on.
  // Serializes plan + delete + apply against any other rewrite-bearing
  // operation on this vault, so a concurrent move_note can't see a vault
  // state mid-delete.
  if (removeReferences) {
    return withFileLock(vaultRewriteLockKey(vaultPath), performDelete);
  }
  return performDelete();
}

async function linkOrCopyFileNoReplace(fullOldPath: string, fullNewPath: string): Promise<void> {
  try {
    await fs.link(fullOldPath, fullNewPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!COPY_FALLBACK_CODES.has(code)) throw err;
  }
  await fs.copyFile(fullOldPath, fullNewPath, fsConstants.COPYFILE_EXCL);
}

async function createDestinationNoReplace(
  vaultPath: string,
  fullOldPath: string,
  fullNewPath: string,
): Promise<void> {
  const sourceStat = await fs.lstat(fullOldPath);
  if (sourceStat.isSymbolicLink()) {
    const sourceCanonical = await assertRealPathWithinVault(fullOldPath, vaultPath);
    const linkTarget = await fs.readlink(fullOldPath);
    let createdSymlink = false;
    try {
      if (IS_WIN32) {
        await fs.symlink(linkTarget, fullNewPath, "file");
      } else {
        await fs.symlink(linkTarget, fullNewPath);
      }
      createdSymlink = true;
      const destCanonical = await assertRealPathWithinVault(fullNewPath, vaultPath);
      if (destCanonical.realPath !== sourceCanonical.realPath) {
        throw new Error("Refusing to move symlink because the destination would point somewhere else");
      }
    } catch (err) {
      if (createdSymlink) {
        try { await fs.unlink(fullNewPath); } catch { /* ignore cleanup failure */ }
      }
      throw err;
    }
    return;
  }
  await linkOrCopyFileNoReplace(fullOldPath, fullNewPath);
}

async function movePathNoReplace(
  vaultPath: string,
  fullOldPath: string,
  fullNewPath: string,
  displayNewPath: string,
): Promise<void> {
  let createdDestination = false;
  try {
    await createDestinationNoReplace(vaultPath, fullOldPath, fullNewPath);
    createdDestination = true;
    await unlinkWithRetry(fullOldPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (createdDestination) {
      try { await fs.unlink(fullNewPath); } catch { /* ignore cleanup failure */ }
    }
    if (code === "EEXIST") {
      throw new Error(`Destination already exists: ${displayNewPath}`, { cause: err });
    }
    throw err;
  }
}

export interface MoveNoteOptions {
  /** When true (default), rewrite wikilinks and markdown links in every other
   *  note + canvas to point at the new path. Set false to skip the scan
   *  entirely (faster on large vaults / for scripted bulk moves where the
   *  caller is doing its own link bookkeeping). */
  updateLinks?: boolean;
}

export interface MoveNoteResult {
  /** Vault-relative paths of files whose references were rewritten. Empty
   *  when no other note/canvas referenced the moved file (or `updateLinks`
   *  was false). */
  updatedReferrers: string[];
  /** Per-file failures during the rewrite pass. The move has already
   *  committed by the time these are surfaced. Empty when everything landed
   *  cleanly. */
  failedReferrers: Array<{ path: string; error: string }>;
}

export async function moveNote(
  vaultPath: string,
  oldPath: string,
  newPath: string,
  options: MoveNoteOptions = {},
): Promise<MoveNoteResult> {
  assertMarkdownNotePath(oldPath);
  assertMarkdownNotePath(newPath);
  const updateLinks = options.updateLinks !== false;
  // Moving preserves the source bytes at a new path, so the source has to pass
  // both write permission for the rename and read permission for disclosure.
  await resolveVaultPathSafe(vaultPath, oldPath, "read");
  const fullOldPath = await resolveVaultPathSafe(vaultPath, oldPath, "write");
  const fullNewPath = await resolveVaultPathSafe(vaultPath, newPath, "write");
  const doRename = async (): Promise<void> => {
    // A case-only rename (Note.md to note.md on a case-insensitive FS)
    // resolves to the same inode, so a fail-on-exists move would reject the
    // caller's intended rename. Keep that path on the native rename retry
    // helper; every other move must create the destination with no-replace
    // semantics before unlinking the old name.
    if (lockKey(fullOldPath) === lockKey(fullNewPath)) {
      await renameWithRetry(fullOldPath, fullNewPath);
      return;
    }
    await fs.mkdir(path.dirname(fullNewPath), { recursive: true });
    await movePathNoReplace(vaultPath, fullOldPath, fullNewPath, newPath);
  };

  const performMove = async (): Promise<MoveNoteResult> => {
    // Build the rewrite plan from the *pre-move* vault state — resolution
    // must see the file at its old path so wikilinks pointing at it are
    // matched. Importing here (not at module top) breaks an import cycle:
    // link-rewriter depends on this module's read/list/lock helpers.
    let plan: import("./link-rewriter.js").RewritePlan | null = null;
    if (updateLinks) {
      const { planMoveRewrites } = await import("./link-rewriter.js");
      const preMoveNotes = await listNotes(vaultPath);
      plan = await planMoveRewrites(vaultPath, oldPath, newPath, preMoveNotes);
    }

    // Lock in deterministic order to prevent deadlock when two concurrent
    // moves cross-reference the same pair of paths. When both paths share
    // the same lock key (case-only rename on case-insensitive FS), a single
    // lock is sufficient — nesting the same key deadlocks.
    if (lockKey(fullOldPath) === lockKey(fullNewPath)) {
      await withFileLock(fullOldPath, doRename);
    } else {
      const [first, second] = [fullOldPath, fullNewPath].sort() as [string, string];
      await withFileLock(first, async () => {
        await withFileLock(second, doRename);
      });
    }

    if (!plan) return { updatedReferrers: [], failedReferrers: [] };

    const { applyRewrites } = await import("./link-rewriter.js");
    const result = await applyRewrites(vaultPath, plan);
    return {
      updatedReferrers: result.updated,
      failedReferrers: result.failed,
    };
  };

  // When `updateLinks` is on, serialize the entire plan + rename + apply
  // sequence under a single vault-level lock so concurrent move_note calls
  // can't see each other's mid-flight state. Without this, two parallel
  // moves can each plan against a snapshot that's stale by the time they
  // apply — the `expected: string` content check in `applyEditsBackToFront`
  // turns those races into reported failures rather than corruption, but
  // serializing avoids the partial-failure mode entirely. With
  // `updateLinks: false` the rename has no plan/apply phases so the
  // existing per-file locks are sufficient and the vault lock is skipped.
  if (updateLinks) {
    return withFileLock(vaultRewriteLockKey(vaultPath), performMove);
  }
  return performMove();
}

/**
 * Pure scanner: search a pre-loaded set of note contents for `query`. Used by
 * both `searchNotes` (which loads its own content) and the `search_notes`
 * tool (which loads via the mtime cache). Keeping the matching logic
 * separate from the I/O loop lets the tool avoid duplicate reads when the
 * same vault has been scanned recently.
 */
export function searchInContents(
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  query: string,
  options?: { caseSensitive?: boolean; maxResults?: number },
): SearchResult[] {
  const caseSensitive = options?.caseSensitive ?? false;
  const maxResults = options?.maxResults ?? 100;
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  if (searchQuery.length === 0) return [];

  const results: SearchResult[] = [];
  for (const notePath of notes) {
    const content = contents.get(notePath);
    if (content === undefined) continue;

    const lines = content.split("\n");
    const rawMatches: SearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const compareLine = caseSensitive ? line : line.toLowerCase();
      let startIndex = 0;
      while (true) {
        const col = compareLine.indexOf(searchQuery, startIndex);
        if (col === -1) break;
        rawMatches.push({
          line: i + 1,
          content: formatSearchSnippet(line, col, searchQuery.length),
          column: col,
        });
        startIndex = col + searchQuery.length;
      }
    }
    if (rawMatches.length === 0) continue;
    results.push({
      path: notePath,
      relativePath: notePath,
      matches: collapseSearchLineMatches(rawMatches),
      score: scoreLexicalMatches(notePath, lines, rawMatches, searchQuery, caseSensitive),
    });
  }
  // Primary: lexical focus score (desc). Secondary: relative path (asc) — otherwise
  // tie-breaking order depends on iteration timing, which makes results for
  // equal-score queries non-deterministic between runs.
  results.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return results.slice(0, maxResults);
}

function collapseSearchLineMatches(matches: readonly SearchMatch[]): SearchMatch[] {
  const seenLines = new Set<number>();
  return matches.filter((match) => {
    if (seenLines.has(match.line)) return false;
    seenLines.add(match.line);
    return true;
  });
}

function formatSearchSnippet(line: string, column: number, queryLength: number): string {
  const trimmedStart = line.trimStart();
  const leadingTrimmedChars = line.length - trimmedStart.length;
  const trimmedLine = trimmedStart.trimEnd();
  const maxSnippetChars = Math.max(
    SEARCH_SNIPPET_MAX_CHARS,
    queryLength + SEARCH_SNIPPET_OMISSION.length * 2,
  );

  if (trimmedLine.length <= maxSnippetChars) return trimmedLine;

  const snippetColumn = Math.max(0, column - leadingTrimmedChars);
  const queryStart = Math.min(snippetColumn, trimmedLine.length);
  const bodyMaxChars = maxSnippetChars - SEARCH_SNIPPET_OMISSION.length * 2;
  let start = Math.max(0, queryStart - Math.floor((bodyMaxChars - queryLength) / 2));
  const end = Math.min(trimmedLine.length, start + bodyMaxChars);
  if (end === trimmedLine.length) start = Math.max(0, end - bodyMaxChars);

  const prefix = start > 0 ? SEARCH_SNIPPET_OMISSION : "";
  const suffix = end < trimmedLine.length ? SEARCH_SNIPPET_OMISSION : "";
  return `${prefix}${trimmedLine.slice(start, end)}${suffix}`;
}

function scoreLexicalMatches(
  notePath: string,
  lines: readonly string[],
  matches: readonly SearchMatch[],
  searchQuery: string,
  caseSensitive: boolean,
): number {
  const matchingLines = new Set(matches.map((match) => match.line)).size;
  const repeatedSameLineMatches = matches.length - matchingLines;
  const pathText = caseSensitive ? notePath : notePath.toLowerCase();
  const firstHeading = lines.find((line) => line.trimStart().startsWith("#")) ?? "";
  const headingText = caseSensitive ? firstHeading : firstHeading.toLowerCase();

  let score = matchingLines + Math.log1p(matches.length) * SEARCH_MATCH_COUNT_WEIGHT;
  if (pathText.includes(searchQuery)) score += SEARCH_PATH_MATCH_BOOST;
  if (headingText.includes(searchQuery)) score += SEARCH_HEADING_MATCH_BOOST;
  score -= repeatedSameLineMatches * SEARCH_REPEATED_SAME_LINE_PENALTY;
  return Math.max(0, score);
}

export async function searchNotes(
  vaultPath: string,
  query: string,
  options?: {
    caseSensitive?: boolean;
    maxResults?: number;
    folder?: string;
  },
): Promise<SearchResult[]> {
  const notes = await listNotes(vaultPath, options?.folder);

  // Scan notes in parallel with bounded concurrency. Sequential iteration
  // would pay one realpath syscall per note on every query — unusable on
  // 10k+ note vaults. Errors are swallowed per-item (documented
  // `mapConcurrent` contract) so one unreadable note doesn't abort the
  // search. We intentionally do NOT log the relative note path here — it
  // used to go to stderr and could leak vault layout into shared logs.
  const contents = new Map<string, string>();
  await mapConcurrent(notes, SCAN_CONCURRENCY, async (notePath) => {
    try {
      const content = await readNote(vaultPath, notePath);
      contents.set(notePath, content);
    } catch {
      // ignore per-file failures
    }
    return undefined;
  });

  return searchInContents(notes, contents, query, options);
}

export async function getNoteStats(
  vaultPath: string,
  relativePath: string,
  options?: { realVaultRoot?: string },
): Promise<{ size: number; created: Date | null; modified: Date | null }> {
  const { handle, stats } = await openVaultFileForRead(vaultPath, relativePath, "read", options);
  try {
    return {
      size: stats.size,
      created: stats.birthtime ?? null,
      modified: stats.mtime ?? null,
    };
  } finally {
    await handle.close();
  }
}

export async function listCanvasFiles(
  vaultPath: string,
): Promise<string[]> {
  // No `isExcluded` filter needed: `walkVault` already prunes excluded dirs
  // at every traversal level.
  const entries = await walkVault(await getRealVaultRoot(vaultPath), [".canvas"]);
  return filterReadable(entries).sort();
}

export async function listBaseFiles(
  vaultPath: string,
): Promise<string[]> {
  // No `isExcluded` filter needed: `walkVault` already prunes excluded dirs
  // at every traversal level.
  const entries = await walkVault(await getRealVaultRoot(vaultPath), [".base"]);
  return filterReadable(entries).sort();
}

/**
 * Enumerate every attachment in the vault — every file that isn't a
 * markdown note, canvas, or Base. Attachments are typically images, PDFs,
 * audio/video clips, code snippets dropped in via paste-as-file, etc.
 */
export async function listAttachments(
  vaultPath: string,
): Promise<string[]> {
  // No `isExcluded` filter needed: `walkVaultExcluding` already prunes
  // excluded dirs at every traversal level.
  const entries = await walkVaultExcluding(
    await getRealVaultRoot(vaultPath),
    [".md", ".canvas", ".base"],
  );
  return filterReadable(entries).sort();
}

export async function getAttachmentStats(
  vaultPath: string,
  relativePath: string,
): Promise<{ size: number; modified: Date | null }> {
  const { handle, stats } = await openVaultFileForRead(vaultPath, relativePath);
  try {
    return { size: stats.size, modified: stats.mtime ?? null };
  } finally {
    await handle.close();
  }
}

export async function readBaseFile(
  vaultPath: string,
  relativePath: string,
): Promise<string> {
  if (!relativePath.toLowerCase().endsWith(".base")) {
    throw new Error(`Not a Base file: ${relativePath}`);
  }
  const { handle, stats } = await openVaultFileForRead(vaultPath, relativePath);
  if (stats.size > MAX_BASE_FILE_BYTES) {
    await handle.close();
    throw new Error(
      `Base file exceeds size cap (${stats.size} > ${MAX_BASE_FILE_BYTES} bytes)`,
    );
  }
  try {
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

function assertCanvasFileSize(size: number, relativePath: string): void {
  if (size > MAX_CANVAS_FILE_BYTES) {
    throw new Error(
      `Canvas file exceeds size cap (${size} > ${MAX_CANVAS_FILE_BYTES} bytes): ${relativePath}`,
    );
  }
}

function assertCanvasDataCounts(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  relativePath: string,
): void {
  if (nodes.length > MAX_CANVAS_NODES) {
    throw new Error(
      `Canvas node count exceeds cap (${nodes.length} > ${MAX_CANVAS_NODES}): ${relativePath}`,
    );
  }
  if (edges.length > MAX_CANVAS_EDGES) {
    throw new Error(
      `Canvas edge count exceeds cap (${edges.length} > ${MAX_CANVAS_EDGES}): ${relativePath}`,
    );
  }
}

function canvasDataFromObject(data: Record<string, unknown>, relativePath: string): CanvasData {
  const nodes = Array.isArray(data.nodes) ? (data.nodes as CanvasData["nodes"]) : [];
  const edges = Array.isArray(data.edges) ? (data.edges as CanvasData["edges"]) : [];
  assertCanvasDataCounts(nodes, edges, relativePath);

  return { nodes, edges };
}

function assertCanvasJsonObject(parsed: unknown, relativePath: string): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid canvas file (expected JSON object): ${relativePath}`);
  }
  return parsed as Record<string, unknown>;
}

function serializeCanvasFile(data: Record<string, unknown>, relativePath: string): string {
  const serialized = JSON.stringify(data, null, 2);
  assertCanvasFileSize(Buffer.byteLength(serialized, "utf-8"), relativePath);
  return serialized;
}

export async function readCanvasFile(
  vaultPath: string,
  relativePath: string,
): Promise<CanvasData> {
  const { handle, stats } = await openVaultFileForRead(vaultPath, relativePath);
  let content: string;
  try {
    assertCanvasFileSize(stats.size, relativePath);
    content = await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid canvas file (malformed JSON): ${relativePath}`);
  }
  // BUG-14: runtime validation before casting. JSON.parse can return any JSON
  // primitive (string, number, boolean, null, array) - only a non-null object
  // is a valid canvas structure.
  const data = assertCanvasJsonObject(parsed, relativePath);
  if (!Array.isArray(data.nodes)) {
    return { nodes: [], edges: [] };
  }
  return canvasDataFromObject(data, relativePath);
}

export async function writeCanvasFile(
  vaultPath: string,
  relativePath: string,
  data: CanvasData,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    assertCanvasDataCounts(data.nodes, data.edges, relativePath);
    const serialized = serializeCanvasFile(data as unknown as Record<string, unknown>, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await atomicWriteFile(fullPath, serialized);
  });
}

/**
 * Atomic read-modify-write for canvas files. Locks across read, mutation, and
 * write so concurrent node/edge additions can't lose each other's writes.
 *
 * Preserves unknown top-level keys in the canvas JSON (e.g. `viewport`,
 * future Obsidian metadata) — only `nodes` and `edges` are replaced by the
 * transform's result. Extra fields on individual node/edge objects also
 * survive because the transform typically mutates the array elements in
 * place.
 */
export async function updateCanvasFile(
  vaultPath: string,
  relativePath: string,
  transform: (data: CanvasData) => CanvasData | Promise<CanvasData>,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(vaultPath, relativePath, fullPath, "write");
    let raw: string;
    try {
      assertCanvasFileSize(opened.stats.size, relativePath);
      raw = await opened.handle.readFile("utf-8");
    } finally {
      await opened.handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid canvas file (malformed JSON): ${relativePath}`);
    }
    const obj = assertCanvasJsonObject(parsed, relativePath);
    const current = canvasDataFromObject(obj, relativePath);
    const next = await transform(current);
    assertCanvasDataCounts(next.nodes, next.edges, relativePath);
    const out = { ...obj, nodes: next.nodes, edges: next.edges };
    const serialized = serializeCanvasFile(out, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await atomicWriteFile(fullPath, serialized);
  });
}
