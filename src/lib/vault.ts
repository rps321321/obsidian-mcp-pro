import fs from "fs/promises";
import path from "path";
import type { SearchResult, SearchMatch, CanvasData } from "../types.js";

const EXCLUDED_DIRS = [".obsidian", ".trash", ".git"];
const EXCLUDED_SET = new Set(EXCLUDED_DIRS);

function isExcluded(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  return EXCLUDED_DIRS.some(
    (dir) => normalized.startsWith(`${dir}/`) || normalized === dir,
  );
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
        // Prune excluded directories only at the vault root level.
        if (relPrefix === "" && EXCLUDED_SET.has(name.toLowerCase())) continue;
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
  if (relativePath.includes('\0')) {
    throw new Error("Invalid path: contains null byte");
  }
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolved.startsWith(resolvedVault + path.sep) && resolved !== resolvedVault) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}

export async function listNotes(
  vaultPath: string,
  folder?: string,
): Promise<string[]> {
  const baseDir = folder
    ? resolveVaultPath(vaultPath, folder)
    : path.resolve(vaultPath);

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
  const fullPath = resolveVaultPath(vaultPath, relativePath);
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
): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

export async function appendToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, relativePath);
  const existing = await fs.readFile(fullPath, "utf-8");
  const separator = existing.endsWith("\n") ? "" : "\n";
  await fs.writeFile(fullPath, existing + separator + content, "utf-8");
}

export async function prependToNote(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, relativePath);
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
}

export async function deleteNote(
  vaultPath: string,
  relativePath: string,
  useTrash = true,
): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, relativePath);

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
}

export async function moveNote(
  vaultPath: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const fullOldPath = resolveVaultPath(vaultPath, oldPath);
  const fullNewPath = resolveVaultPath(vaultPath, newPath);
  try {
    await fs.access(fullNewPath);
    throw new Error(`Destination already exists: ${newPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(fullNewPath), { recursive: true });
  await fs.rename(fullOldPath, fullNewPath);
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
      results.push({
        path: resolveVaultPath(vaultPath, notePath),
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
  const fullPath = resolveVaultPath(vaultPath, relativePath);
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
  const entries = await walkVault(path.resolve(vaultPath), [".canvas"]);

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
  const fullPath = resolveVaultPath(vaultPath, relativePath);
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
  const fullPath = resolveVaultPath(vaultPath, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify(data, null, 2), "utf-8");
}
