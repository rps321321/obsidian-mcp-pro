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
  const next = prev.then(fn, fn);
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
const realVaultCache = new Map<string, string>();
async function getRealVaultRoot(vaultPath: string): Promise<string> {
  const key = path.resolve(vaultPath);
  const cached = realVaultCache.get(key);
  if (cached) return cached;
  let real: string;
  try {
    real = await fs.realpath(key);
  } catch {
    real = key;
  }
  realVaultCache.set(key, real);
  return real;
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

export async function prependToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath);
  await withFileLock(fullPath, async () => {
    const existing = await fs.readFile(fullPath, "utf-8");

    // Detect frontmatter block (starts with --- on first line)
    const frontmatterMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);

    let result: string;
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[0];
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
  // Lock in deterministic order to prevent deadlock when two concurrent
  // moves cross-reference the same pair of paths.
  const [first, second] = [fullOldPath, fullNewPath].sort();
  await withFileLock(first, async () => {
    await withFileLock(second, async () => {
      try {
        await fs.access(fullNewPath);
        throw new Error(`Destination already exists: ${newPath}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await fs.mkdir(path.dirname(fullNewPath), { recursive: true });
      await fs.rename(fullOldPath, fullNewPath);
    });
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

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, maxResults);
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
    const obj = parsed as Record<string, unknown>;
    const current: CanvasData = {
      nodes: Array.isArray(obj.nodes) ? (obj.nodes as CanvasData["nodes"]) : [],
      edges: Array.isArray(obj.edges) ? (obj.edges as CanvasData["edges"]) : [],
    };
    const next = await transform(current);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(next, null, 2), "utf-8");
  });
}
