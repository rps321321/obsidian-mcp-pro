import fs from "fs/promises";
import path from "path";
import {
  EXCLUDED_SET,
  filterReadable,
  getRealVaultRoot,
  openVaultFileForRead,
} from "./vault-fs.js";

/**
 * Walk every file in the vault, then exclude the listed extensions.
 * Used by attachment listing — Obsidian recognizes anything that isn't a
 * markdown / canvas / base file as an attachment, so it's easier to drop
 * the known text formats than enumerate every binary type a user might
 * paste in.
 */
async function walkVaultExcluding(
  baseDir: string,
  excludedExtensions: string[]
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
      if (name.includes("\0")) continue;

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

export async function getNoteStats(
  vaultPath: string,
  relativePath: string,
  options?: { realVaultRoot?: string }
): Promise<{ size: number; created: Date | null; modified: Date | null }> {
  const { handle, stats } = await openVaultFileForRead(
    vaultPath,
    relativePath,
    "read",
    options
  );
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

/**
 * Enumerate every attachment in the vault — every file that isn't a
 * markdown note, canvas, or Base. Attachments are typically images, PDFs,
 * audio/video clips, code snippets dropped in via paste-as-file, etc.
 */
export async function listAttachments(vaultPath: string): Promise<string[]> {
  // No `isExcluded` filter needed: `walkVaultExcluding` already prunes
  // excluded dirs at every traversal level.
  const entries = await walkVaultExcluding(await getRealVaultRoot(vaultPath), [
    ".md",
    ".canvas",
    ".base",
  ]);
  return filterReadable(entries).sort();
}

export async function getAttachmentStats(
  vaultPath: string,
  relativePath: string
): Promise<{ size: number; modified: Date | null }> {
  const { handle, stats } = await openVaultFileForRead(vaultPath, relativePath);
  try {
    return { size: stats.size, modified: stats.mtime ?? null };
  } finally {
    await handle.close();
  }
}
