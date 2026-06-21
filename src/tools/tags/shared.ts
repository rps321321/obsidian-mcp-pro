import { escapeControlChars } from "../../lib/errors.js";
import { formatUntrustedVaultContent, indentBlock } from "../../lib/tool-output.js";
import { extractTags } from "../../lib/markdown.js";

import type { TagInfo } from "../../types.js";

const TAG_INDEX_CACHE_LIMIT = 8;

interface TagIndexEntry {
  path: string;
  tags: string[];
}

export interface TagIndexCacheEntry {
  fingerprint: string;
  noteOrder: Map<string, number>;
  tagInfos: TagInfo[];
  tagToFiles: Map<string, string[]>;
}

export const tagIndexCache = new Map<string, TagIndexCacheEntry>();

export function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export function displayTagValue(value: string): string {
  return escapeControlChars(value);
}

export function untrustedTagBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

export function tagIndexFingerprint(
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
): string {
  return notes
    .map((notePath) => {
      const mtime = mtimes.get(notePath);
      return `${notePath}\0${contents.has(notePath) && mtime !== undefined ? mtime : "missing"}`;
    })
    .join("\0");
}

export function getCachedTagIndex(
  vaultPath: string,
  notes: readonly string[],
  contents: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
): TagIndexCacheEntry {
  const fingerprint = tagIndexFingerprint(notes, contents, mtimes);
  const cached = tagIndexCache.get(vaultPath);
  if (cached?.fingerprint === fingerprint) {
    tagIndexCache.delete(vaultPath);
    tagIndexCache.set(vaultPath, cached);
    return cached;
  }

  const entries: TagIndexEntry[] = [];
  const noteOrder = new Map<string, number>();
  const tagMap = new Map<string, { tag: string; files: Set<string> }>();
  for (const notePath of notes) {
    const content = contents.get(notePath);
    if (content === undefined) continue;
    const tags = extractTags(content);
    noteOrder.set(notePath, entries.length);
    entries.push({ path: notePath, tags });
    for (const tag of tags) {
      const normalizedTag = tag.toLowerCase();
      const existing = tagMap.get(normalizedTag);
      if (existing) {
        existing.files.add(notePath);
      } else {
        tagMap.set(normalizedTag, {
          tag: normalizedTag,
          files: new Set([notePath]),
        });
      }
    }
  }

  const tagInfos: TagInfo[] = Array.from(tagMap.values()).map(({ tag, files }) => ({
    tag,
    count: files.size,
    files: [...files],
  }));
  const tagToFiles = new Map<string, string[]>();
  for (const info of tagInfos) tagToFiles.set(info.tag, info.files);

  const fresh = { fingerprint, noteOrder, tagInfos, tagToFiles };
  tagIndexCache.set(vaultPath, fresh);
  while (tagIndexCache.size > TAG_INDEX_CACHE_LIMIT) {
    const oldestKey = tagIndexCache.keys().next().value;
    if (oldestKey === undefined) break;
    tagIndexCache.delete(oldestKey);
  }

  return fresh;
}
