import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { renameWithRetry, unlinkWithRetry } from "./fs-ops.js";
import {
  assertNoteContentSize,
  assertNoteFileSize,
  assertRealPathWithinVault,
  atomicWriteFile,
  CASE_INSENSITIVE_FS,
  getRealVaultRoot,
  IS_WIN32,
  lockKey,
  openResolvedVaultFileForRead,
  resolveVaultPathSafe,
  vaultRewriteLockKey,
  withFileLock,
} from "./vault-fs.js";
import {
  assertMarkdownNotePath,
  listNotes,
  readNote,
  readNoteLineRange,
  type NoteLineRangeRead,
} from "./note-reads.js";
import {
  applyRewrites,
  planDeleteRewrites,
  planMoveRewrites,
  type RewritePlan,
} from "./link-rewriter.js";

// Re-export foundation primitives so external call sites keep importing from vault.js.
export {
  resolveVaultPathSafe,
  readVaultTextFile,
  atomicWriteFile,
  withFileLock,
  vaultRewriteLockKey,
  resolveVaultPath,
  resolveVaultInternalPathSafe,
  getVaultRootRealPath,
  openVaultFileForRead,
  openVaultInternalFileForRead,
  assertNoteFileSize,
  setMaxNoteFileBytesForTests,
  setMaxNoteLineRangeBytesForTests,
  type ValidatedVaultFile,
} from "./vault-fs.js";

// Re-export note-read APIs so external call sites keep importing from vault.js.
export { readNote, readNoteLineRange, listNotes, type NoteLineRangeRead };

// Re-export canvas + bases file-type APIs so external call sites keep
// importing from vault.js.
export {
  listCanvasFiles,
  readCanvasFile,
  writeCanvasFile,
  updateCanvasFile,
  MAX_CANVAS_FILE_BYTES,
} from "./canvas.js";
export { listBaseFiles, readBaseFile } from "./bases.js";

// Re-export search + stats query APIs so external call sites keep importing
// from vault.js.
export { searchInContents, searchNotes } from "./vault-search.js";
export {
  getNoteStats,
  listAttachments,
  getAttachmentStats,
} from "./vault-stats.js";

const COPY_FALLBACK_CODES = new Set([
  "EXDEV",
  "EPERM",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

async function removeEmptyExclusivePlaceholder(
  fullPath: string
): Promise<void> {
  try {
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile() || stat.size !== 0) return;
    await fs.unlink(fullPath);
  } catch {
    // Best effort only: preserving an unexpected file is safer than deleting
    // something that may have changed after the failed exclusive create.
  }
}

export async function writeNote(
  vaultPath: string,
  relativePath: string,
  content: string,
  options?: { exclusive?: boolean }
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
            const err = new Error(
              `File already exists: ${relativePath}`
            ) as NodeJS.ErrnoException;
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
          const e = new Error(
            `File already exists: ${relativePath}`
          ) as NodeJS.ErrnoException;
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
  transform: (existing: string) => string | Promise<string>
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(
      vaultPath,
      relativePath,
      fullPath,
      "write"
    );
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
  content: string
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(
      vaultPath,
      relativePath,
      fullPath,
      "write"
    );
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
    if (lines >= MAX_FRONTMATTER_LINES || offset >= MAX_FRONTMATTER_BYTES)
      return null;
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
  content: string
): Promise<void> {
  assertMarkdownNotePath(relativePath);
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(
      vaultPath,
      relativePath,
      fullPath,
      "write"
    );
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
    const candidate = path.join(
      parsed.dir,
      `${parsed.name}.${suffix}${parsed.ext}`
    );
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(
    `Could not allocate unique trash path for ${path.basename(trashFullPath)}`
  );
}

async function ensureTrashParentDirectory(
  vaultPath: string,
  trashRoot: string,
  parentDir: string
): Promise<void> {
  const root = path.resolve(trashRoot);
  const parent = path.resolve(parentDir);
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new Error("Invalid trash path parent");
  }

  const realVault = await getRealVaultRoot(vaultPath);
  const relative = path.relative(root, parent);
  const segments =
    relative === "" ? [] : relative.split(path.sep).filter(Boolean);
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
      throw new Error(
        `Trash path parent is not a directory: ${path.basename(current)}`
      );
    }
  }
}

export async function deleteNote(
  vaultPath: string,
  relativePath: string,
  options: DeleteNoteOptions = {}
): Promise<DeleteNoteResult> {
  assertMarkdownNotePath(relativePath);
  const permanent = options.permanent === true;
  const removeReferences = permanent && options.removeReferences === true;
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");

  const performDelete = async (): Promise<DeleteNoteResult> => {
    // Build the rewrite plan from the *pre-delete* vault state — resolution
    // must see the file at its current path so wikilinks pointing at it are
    // matched. Only built when removeReferences is on.
    let plan: RewritePlan | null = null;
    if (removeReferences) {
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
        await ensureTrashParentDirectory(
          vaultPath,
          trashRoot,
          path.dirname(trashFullPath)
        );
        // Realpath check on the canonical destination: rejects a symlink swap
        // after parent creation but before the rename.
        await assertRealPathWithinVault(trashFullPath, vaultPath);
        const finalTrashPath = await chooseTrashPath(trashFullPath);
        const finalTrashRelPath = path
          .relative(resolvedVault, finalTrashPath)
          .replace(/\\/g, "/");
        await movePathNoReplace(
          vaultPath,
          fullPath,
          finalTrashPath,
          finalTrashRelPath
        );
      } else {
        await fs.unlink(fullPath);
      }
    });

    if (!plan) return { updatedReferrers: [], failedReferrers: [] };

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

async function linkOrCopyFileNoReplace(
  fullOldPath: string,
  fullNewPath: string
): Promise<void> {
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
  fullNewPath: string
): Promise<void> {
  const sourceStat = await fs.lstat(fullOldPath);
  if (sourceStat.isSymbolicLink()) {
    const sourceCanonical = await assertRealPathWithinVault(
      fullOldPath,
      vaultPath
    );
    const linkTarget = await fs.readlink(fullOldPath);
    let createdSymlink = false;
    try {
      if (IS_WIN32) {
        await fs.symlink(linkTarget, fullNewPath, "file");
      } else {
        await fs.symlink(linkTarget, fullNewPath);
      }
      createdSymlink = true;
      const destCanonical = await assertRealPathWithinVault(
        fullNewPath,
        vaultPath
      );
      if (destCanonical.realPath !== sourceCanonical.realPath) {
        throw new Error(
          "Refusing to move symlink because the destination would point somewhere else"
        );
      }
    } catch (err) {
      if (createdSymlink) {
        try {
          await fs.unlink(fullNewPath);
        } catch {
          /* ignore cleanup failure */
        }
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
  displayNewPath: string
): Promise<void> {
  let createdDestination = false;
  try {
    await createDestinationNoReplace(vaultPath, fullOldPath, fullNewPath);
    createdDestination = true;
    await unlinkWithRetry(fullOldPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (createdDestination) {
      try {
        await fs.unlink(fullNewPath);
      } catch {
        /* ignore cleanup failure */
      }
    }
    if (code === "EEXIST") {
      throw new Error(`Destination already exists: ${displayNewPath}`, {
        cause: err,
      });
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
  options: MoveNoteOptions = {}
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
    // matched.
    let plan: RewritePlan | null = null;
    if (updateLinks) {
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
      const [first, second] = [fullOldPath, fullNewPath].sort() as [
        string,
        string,
      ];
      await withFileLock(first, async () => {
        await withFileLock(second, doRename);
      });
    }

    if (!plan) return { updatedReferrers: [], failedReferrers: [] };

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
