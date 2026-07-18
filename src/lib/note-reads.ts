/**
 * Pure note-read operations (list / full read / line-range read).
 *
 * Layer: imports from vault-fs and lower modules only, never from vault.ts
 * (vault re-exports this module).
 */
import type { FileHandle } from "fs/promises";
import path from "path";
import { StringDecoder } from "string_decoder";
import {
  assertNoteContentSize,
  assertNoteFileSize,
  assertNoteLineRangeBytes,
  filterReadable,
  getMaxNoteLineRangeBytes,
  getRealVaultRoot,
  openVaultFileForRead,
  resolveVaultPathSafe,
  walkVault,
} from "./vault-fs.js";

/** Reject non-markdown note paths used by note read/write APIs. */
export function assertMarkdownNotePath(relativePath: string): void {
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw new Error(`Not a markdown note: ${relativePath}`);
  }
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
  folder?: string
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
  relativePath: string
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
  endLine: number
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
        assertNoteLineRangeBytes(
          relativePath,
          outputBytes + separatorBytes + lineBytes
        );
        outputBytes += separatorBytes + lineBytes;
        collected.push(line);
      }
      const reachedRequestedEnd = currentLine >= endLine;
      currentLine += 1;
      return reachedRequestedEnd;
    };

    while (true) {
      const remainingBytes = getMaxNoteLineRangeBytes() - scannedBytes;
      const bytesToRead = Math.min(
        buffer.length,
        Math.max(remainingBytes + 1, 1)
      );
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
      return {
        text: "",
        pastEndLine: { requested: startLine, total: totalLines },
      };
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
