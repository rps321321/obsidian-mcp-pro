import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { mapConcurrent } from "./concurrency.js";
import { assertAllowed, type AccessKind } from "./permissions.js";
import type { SearchResult, SearchMatch, CanvasData } from "../types.js";

// Bounded fan-out for vault-wide scans. Higher values saturate the event loop
// on spinning disks; lower values leave SSD throughput on the table. 8 is the
// sweet spot on a typical developer workstation.
const SCAN_CONCURRENCY = 8;

const EXCLUDED_DIRS = [".obsidian", ".trash", ".git"];
const EXCLUDED_SET = new Set(EXCLUDED_DIRS);

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

function isExcluded(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  // Reject if ANY path segment is an excluded dir (not just root-level).
  // Prevents nested dirs like `projects/.git/config` from being exposed.
  return normalized.split("/").some((seg) => EXCLUDED_SET.has(seg));
}

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
// Windows raises EPERM/EBUSY/EACCES from `fs.rename` when another handle has
// the target open for read (Win32's default share mode is stricter than
// POSIX). Readers typically release within a few ms — retry with linear
// backoff before surfacing the error. POSIX renames never hit this transient
// class: on POSIX, EACCES from rename(2) means the caller structurally lacks
// write permission on a containing directory, which will not clear by
// waiting — so we only retry these codes on Windows.
const RENAME_RETRY_CODES: ReadonlySet<string> = process.platform === "win32"
  ? new Set(["EPERM", "EBUSY", "EACCES"])
  : new Set();
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160];
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RENAME_RETRY_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

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
      if (entry.isDirectory()) {
        // Prune excluded directory names at ANY depth. Obsidian's own
        // subfolders aside, nested `.git`/`.obsidian`/`.trash` directories
        // should never be surfaced to clients.
        if (EXCLUDED_SET.has(name.toLowerCase())) continue;
        const nextPrefix = relPrefix === "" ? name : `${relPrefix}/${name}`;
        await walk(path.join(dir, name), nextPrefix);
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
      if (entry.isDirectory()) {
        if (EXCLUDED_SET.has(name.toLowerCase())) continue;
        const nextPrefix = relPrefix === "" ? name : `${relPrefix}/${name}`;
        await walk(path.join(dir, name), nextPrefix);
      } else if (entry.isFile()) {
        // Skip dotfiles entirely — `.DS_Store`, `.gitkeep`, editor swap
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
  } catch {
    return key;
  }
}

async function assertRealPathWithinVault(
  resolved: string,
  vaultPath: string,
): Promise<void> {
  const realVault = await getRealVaultRoot(vaultPath);
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
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Path traversal via symlink detected");
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveVaultPathSafe(
  vaultPath: string,
  relativePath: string,
  access: AccessKind = "read",
): Promise<string> {
  const resolved = resolveVaultPath(vaultPath, relativePath, access);
  await assertRealPathWithinVault(resolved, vaultPath);
  return resolved;
}

export async function listNotes(
  vaultPath: string,
  folder?: string,
): Promise<string[]> {
  const baseDir = folder
    ? await resolveVaultPathSafe(vaultPath, folder)
    : await getRealVaultRoot(vaultPath);

  const entries = await walkVault(baseDir, [".md"]);

  const notes: string[] = [];
  for (const rel of entries) {
    const relativeFromVault = folder ? `${folder}/${rel}` : rel;
    if (isExcluded(relativeFromVault)) continue;
    notes.push(relativeFromVault);
  }

  return notes.sort();
}

export async function readNote(
  vaultPath: string,
  relativePath: string,
): Promise<string> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  try {
    return await fs.readFile(fullPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Note not found: ${relativePath}`);
    }
    throw err;
  }
}

export async function writeNote(
  vaultPath: string,
  relativePath: string,
  content: string,
  options?: { exclusive?: boolean },
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
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
    await atomicWriteFile(fullPath, content);
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
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const existing = await fs.readFile(fullPath, "utf-8");
    const next = await transform(existing);
    if (next === existing) return;
    await atomicWriteFile(fullPath, next);
  });
}

export async function appendToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const existing = await fs.readFile(fullPath, "utf-8");
    const separator = existing.endsWith("\n") ? "" : "\n";
    await atomicWriteFile(fullPath, existing + separator + content);
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
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const existing = await fs.readFile(fullPath, "utf-8");

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

export async function deleteNote(
  vaultPath: string,
  relativePath: string,
  options: DeleteNoteOptions = {},
): Promise<DeleteNoteResult> {
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
        const trashDir = path.join(vaultPath, ".trash");
        const trashPath = path.join(trashDir, relativePath);
        const resolvedTrash = path.resolve(trashPath);
        const resolvedTrashDir = path.resolve(trashDir);
        if (!resolvedTrash.startsWith(resolvedTrashDir + path.sep) && resolvedTrash !== resolvedTrashDir) {
          throw new Error(`Invalid trash path: ${relativePath}`);
        }
        await fs.mkdir(path.dirname(trashPath), { recursive: true });
        // Realpath-check the trash destination: guards against `.trash` itself
        // (or an intermediate dir) being a symlink pointing outside the vault.
        await assertRealPathWithinVault(resolvedTrash, vaultPath);
        await fs.rename(fullPath, trashPath);
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
  /** Per-file failures during the rewrite pass. The rename has already
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
  const updateLinks = options.updateLinks !== false;
  const fullOldPath = await resolveVaultPathSafe(vaultPath, oldPath, "write");
  const fullNewPath = await resolveVaultPathSafe(vaultPath, newPath, "write");
  const doRename = async (): Promise<void> => {
    try {
      await fs.access(fullNewPath);
      // A case-only rename (Note.md → note.md on a case-insensitive FS)
      // resolves to the same inode, so `access` succeeds even though the
      // caller intends to rename. Detect that case and allow the rename.
      if (lockKey(fullOldPath) !== lockKey(fullNewPath)) {
        throw new Error(`Destination already exists: ${newPath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fs.mkdir(path.dirname(fullNewPath), { recursive: true });
    await fs.rename(fullOldPath, fullNewPath);
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
      const [first, second] = [fullOldPath, fullNewPath].sort();
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

  const results: SearchResult[] = [];
  for (const notePath of notes) {
    const content = contents.get(notePath);
    if (content === undefined) continue;

    const lines = content.split("\n");
    const matches: SearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const compareLine = caseSensitive ? line : line.toLowerCase();
      let startIndex = 0;
      while (true) {
        const col = compareLine.indexOf(searchQuery, startIndex);
        if (col === -1) break;
        matches.push({ line: i + 1, content: line.trim(), column: col });
        startIndex = col + searchQuery.length;
      }
    }
    if (matches.length === 0) continue;
    results.push({
      path: notePath,
      relativePath: notePath,
      matches,
      score: matches.length,
    });
  }
  // Primary: match count (desc). Secondary: relative path (asc) — otherwise
  // tie-breaking order depends on iteration timing, which makes results for
  // equal-score queries non-deterministic between runs.
  results.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return results.slice(0, maxResults);
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
): Promise<{ size: number; created: Date | null; modified: Date | null }> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  const stats = await fs.stat(fullPath);

  return {
    size: stats.size,
    created: stats.birthtime ?? null,
    modified: stats.mtime ?? null,
  };
}

export async function listCanvasFiles(
  vaultPath: string,
): Promise<string[]> {
  const entries = await walkVault(await getRealVaultRoot(vaultPath), [".canvas"]);

  const canvasFiles: string[] = [];
  for (const rel of entries) {
    if (isExcluded(rel)) continue;
    canvasFiles.push(rel);
  }

  return canvasFiles.sort();
}

export async function listBaseFiles(
  vaultPath: string,
): Promise<string[]> {
  const entries = await walkVault(await getRealVaultRoot(vaultPath), [".base"]);
  const out: string[] = [];
  for (const rel of entries) {
    if (isExcluded(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

/**
 * Enumerate every attachment in the vault — every file that isn't a
 * markdown note, canvas, or Base. Attachments are typically images, PDFs,
 * audio/video clips, code snippets dropped in via paste-as-file, etc.
 */
export async function listAttachments(
  vaultPath: string,
): Promise<string[]> {
  const entries = await walkVaultExcluding(
    await getRealVaultRoot(vaultPath),
    [".md", ".canvas", ".base"],
  );
  const out: string[] = [];
  for (const rel of entries) {
    if (isExcluded(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

export async function getAttachmentStats(
  vaultPath: string,
  relativePath: string,
): Promise<{ size: number; modified: Date | null }> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  const stats = await fs.stat(fullPath);
  return { size: stats.size, modified: stats.mtime ?? null };
}

export async function readBaseFile(
  vaultPath: string,
  relativePath: string,
): Promise<string> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  return fs.readFile(fullPath, "utf-8");
}

export async function readCanvasFile(
  vaultPath: string,
  relativePath: string,
): Promise<CanvasData> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  const content = await fs.readFile(fullPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid canvas file (malformed JSON): ${relativePath}`);
  }
  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.nodes)) {
    return { nodes: [], edges: [] };
  }
  return {
    nodes: data.nodes as CanvasData["nodes"],
    edges: Array.isArray(data.edges) ? data.edges as CanvasData["edges"] : [],
  };
}

export async function writeCanvasFile(
  vaultPath: string,
  relativePath: string,
  data: CanvasData,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await atomicWriteFile(fullPath, JSON.stringify(data, null, 2));
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
    const raw = await fs.readFile(fullPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid canvas file (malformed JSON): ${relativePath}`);
    }
    const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const current: CanvasData = {
      nodes: Array.isArray(obj.nodes) ? (obj.nodes as CanvasData["nodes"]) : [],
      edges: Array.isArray(obj.edges) ? (obj.edges as CanvasData["edges"]) : [],
    };
    const next = await transform(current);
    const out = { ...obj, nodes: next.nodes, edges: next.edges };
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await atomicWriteFile(fullPath, JSON.stringify(out, null, 2));
  });
}
