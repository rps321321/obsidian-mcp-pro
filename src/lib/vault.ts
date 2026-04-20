import fs from "fs/promises";
import path from "path";
import type { SearchResult, SearchMatch, CanvasData } from "../types.js";

const EXCLUDED_DIRS = [".obsidian", ".trash", ".git"];
const EXCLUDED_SET = new Set(EXCLUDED_DIRS);

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
async function withFileLock<T>(fullPath: string, fn: () => Promise<T>): Promise<T> {
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

export function resolveVaultPath(vaultPath: string, relativePath: string): string {
  if (!vaultPath) {
    throw new Error("Vault path is not configured");
  }
  if (relativePath.includes('\0')) {
    throw new Error("Invalid path: contains null byte");
  }
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolved.startsWith(resolvedVault + path.sep) && resolved !== resolvedVault) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  // Reject paths that traverse through excluded directories at any depth.
  // `resolveVaultPath` is the single choke point for all file tool calls.
  const rel = path.relative(resolvedVault, resolved).replace(/\\/g, "/");
  if (rel && rel.split("/").some((seg) => EXCLUDED_SET.has(seg.toLowerCase()))) {
    throw new Error(`Access to excluded directory denied: ${relativePath}`);
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
): Promise<string> {
  const resolved = resolveVaultPath(vaultPath, relativePath);
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
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  await withFileLock(fullPath, async () => {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    // On case-insensitive filesystems (Windows, default macOS), the `wx`
    // flag would silently overwrite `note.md` when the caller asks to create
    // `Note.md`. Do an explicit case-aware collision check first.
    if (options?.exclusive && CASE_INSENSITIVE_FS) {
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
    // `wx` fails if the file exists — atomic create, closes TOCTOU with any
    // earlier `exists()` check by making the write itself the existence test.
    const flag = options?.exclusive ? "wx" : "w";
    await fs.writeFile(fullPath, content, { encoding: "utf-8", flag });
  });
}

/**
 * Atomic read-modify-write: reads existing content, applies `transform`, and
 * writes the result while holding the per-file lock for the full sequence.
 * Prevents lost updates when concurrent callers would otherwise read the same
 * base and overwrite each other's changes.
 */
export async function updateNote(
  vaultPath: string,
  relativePath: string,
  transform: (existing: string) => string | Promise<string>,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  await withFileLock(fullPath, async () => {
    const existing = await fs.readFile(fullPath, "utf-8");
    const next = await transform(existing);
    await fs.writeFile(fullPath, next, "utf-8");
  });
}

export async function appendToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  await withFileLock(fullPath, async () => {
    const existing = await fs.readFile(fullPath, "utf-8");
    const separator = existing.endsWith("\n") ? "" : "\n";
    await fs.writeFile(fullPath, existing + separator + content, "utf-8");
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
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
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

    await fs.writeFile(fullPath, result, "utf-8");
  });
}

export async function deleteNote(
  vaultPath: string,
  relativePath: string,
  useTrash = true,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  await withFileLock(fullPath, async () => {
    if (useTrash) {
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
}

export async function moveNote(
  vaultPath: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const fullOldPath = await resolveVaultPathSafe(vaultPath, oldPath);
  const fullNewPath = await resolveVaultPathSafe(vaultPath, newPath);
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
  // Lock in deterministic order to prevent deadlock when two concurrent
  // moves cross-reference the same pair of paths. When both paths share
  // the same lock key (case-only rename on case-insensitive FS), a single
  // lock is sufficient — nesting the same key deadlocks.
  if (lockKey(fullOldPath) === lockKey(fullNewPath)) {
    await withFileLock(fullOldPath, doRename);
    return;
  }
  const [first, second] = [fullOldPath, fullNewPath].sort();
  await withFileLock(first, async () => {
    await withFileLock(second, doRename);
  });
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
  const caseSensitive = options?.caseSensitive ?? false;
  const maxResults = options?.maxResults ?? 100;

  const notes = await listNotes(vaultPath, options?.folder);
  const results: SearchResult[] = [];

  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (const notePath of notes) {
    if (results.length >= maxResults) break;

    let content: string;
    try {
      content = await readNote(vaultPath, notePath);
    } catch {
      console.error(`Failed to read note during search: ${notePath}`);
      continue;
    }

    const lines = content.split("\n");
    const matches: SearchMatch[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const compareLine = caseSensitive ? line : line.toLowerCase();
      let startIndex = 0;

      while (true) {
        const col = compareLine.indexOf(searchQuery, startIndex);
        if (col === -1) break;

        matches.push({
          line: i + 1,
          content: line.trim(),
          column: col,
        });
        startIndex = col + searchQuery.length;
      }
    }

    if (matches.length > 0) {
      // Don't leak absolute host path to MCP clients — relative is sufficient.
      results.push({
        path: notePath,
        relativePath: notePath,
        matches,
        score: matches.length,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
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
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  await withFileLock(fullPath, async () => {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(data, null, 2), "utf-8");
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
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
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
    await fs.writeFile(fullPath, JSON.stringify(out, null, 2), "utf-8");
  });
}
