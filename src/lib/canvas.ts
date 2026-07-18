import fs from "fs/promises";
import path from "path";
import type { CanvasData } from "../types.js";
import {
  atomicWriteFile,
  filterReadable,
  getRealVaultRoot,
  openResolvedVaultFileForRead,
  openVaultFileForRead,
  resolveVaultPathSafe,
  walkVault,
  withFileLock,
} from "./vault-fs.js";

export const MAX_CANVAS_FILE_BYTES = 1_048_576;
const MAX_CANVAS_NODES = 10_000;
const MAX_CANVAS_EDGES = 20_000;

export async function listCanvasFiles(vaultPath: string): Promise<string[]> {
  // No `isExcluded` filter needed: `walkVault` already prunes excluded dirs
  // at every traversal level.
  const entries = await walkVault(await getRealVaultRoot(vaultPath), [
    ".canvas",
  ]);
  return filterReadable(entries).sort();
}

function assertCanvasFileSize(size: number, relativePath: string): void {
  if (size > MAX_CANVAS_FILE_BYTES) {
    throw new Error(
      `Canvas file exceeds size cap (${size} > ${MAX_CANVAS_FILE_BYTES} bytes): ${relativePath}`
    );
  }
}

function assertCanvasDataCounts(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  relativePath: string
): void {
  if (nodes.length > MAX_CANVAS_NODES) {
    throw new Error(
      `Canvas node count exceeds cap (${nodes.length} > ${MAX_CANVAS_NODES}): ${relativePath}`
    );
  }
  if (edges.length > MAX_CANVAS_EDGES) {
    throw new Error(
      `Canvas edge count exceeds cap (${edges.length} > ${MAX_CANVAS_EDGES}): ${relativePath}`
    );
  }
}

function canvasDataFromObject(
  data: Record<string, unknown>,
  relativePath: string
): CanvasData {
  const nodes = Array.isArray(data.nodes)
    ? (data.nodes as CanvasData["nodes"])
    : [];
  const edges = Array.isArray(data.edges)
    ? (data.edges as CanvasData["edges"])
    : [];
  assertCanvasDataCounts(nodes, edges, relativePath);

  return { nodes, edges };
}

function assertCanvasJsonObject(
  parsed: unknown,
  relativePath: string
): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid canvas file (expected JSON object): ${relativePath}`
    );
  }
  return parsed as Record<string, unknown>;
}

function serializeCanvasFile(
  data: Record<string, unknown>,
  relativePath: string
): string {
  const serialized = JSON.stringify(data, null, 2);
  assertCanvasFileSize(Buffer.byteLength(serialized, "utf-8"), relativePath);
  return serialized;
}

export async function readCanvasFile(
  vaultPath: string,
  relativePath: string
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
  data: CanvasData
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    assertCanvasDataCounts(data.nodes, data.edges, relativePath);
    const serialized = serializeCanvasFile(
      data as unknown as Record<string, unknown>,
      relativePath
    );
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
  transform: (data: CanvasData) => CanvasData | Promise<CanvasData>
): Promise<void> {
  const fullPath = await resolveVaultPathSafe(vaultPath, relativePath, "write");
  await withFileLock(fullPath, async () => {
    const opened = await openResolvedVaultFileForRead(
      vaultPath,
      relativePath,
      fullPath,
      "write"
    );
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
