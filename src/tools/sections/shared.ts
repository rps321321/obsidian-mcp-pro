import path from "path";
import {
  openVaultFileForRead,
  readNote,
  readVaultTextFile,
  resolveVaultPathSafe,
  assertNoteFileSize,
} from "../../lib/vault.js";
import {
  parseHeadings,
} from "../../lib/sections.js";
import { escapeControlChars } from "../../lib/errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";

export const SECTION_LIST_CACHE_LIMIT = 16;
export const SECTION_EDIT_PAYLOAD_MAX_CHARS = 1_000_000;
export const FIND_MAX_LEN = 4096;
export const NOTE_INPUT_MAX_LEN = 1_000_000;

export interface SectionListCacheEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
  text: string;
}

export const sectionListCache = new Map<string, SectionListCacheEntry>();

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function textResultWithMeta(text: string, metaLabel: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(metaLabel),
    }],
  };
}

export function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Escape control characters before embedding values in section-tool display text. */
export const displaySectionValue = escapeControlChars;

export function renderResolvedHeading(label: string, heading: string): string {
  return [
    "Resolved heading:",
    indentBlock(formatUntrustedVaultContent(label, displaySectionValue(heading)), "  "),
  ].join("\n");
}

export async function assertReadableEditTarget(vaultPath: string, notePath: string): Promise<void> {
  await resolveVaultPathSafe(vaultPath, notePath, "read");
}

export function isAsciiDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function regexQuantifierLength(pattern: string, index: number): number {
  const ch = pattern.charAt(index);
  if (ch === "*" || ch === "+" || ch === "?") return 1;
  if (ch !== "{") return 0;

  let i = index + 1;
  let digits = 0;
  while (i < pattern.length && isAsciiDigit(pattern.charAt(i))) {
    i += 1;
    digits += 1;
  }
  if (digits === 0) return 0;
  if (pattern.charAt(i) === "}") return i - index + 1;
  if (pattern.charAt(i) !== ",") return 0;

  i += 1;
  while (i < pattern.length && isAsciiDigit(pattern.charAt(i))) {
    i += 1;
  }
  return pattern.charAt(i) === "}" ? i - index + 1 : 0;
}

export function regexQuantifierCanRepeat(pattern: string, index: number): boolean {
  const ch = pattern.charAt(index);
  if (ch === "*" || ch === "+") return true;
  if (ch === "?") return false;
  if (ch !== "{") return false;

  let i = index + 1;
  let minText = "";
  while (i < pattern.length && isAsciiDigit(pattern.charAt(i))) {
    minText += pattern.charAt(i);
    i += 1;
  }
  if (minText.length === 0) return false;
  if (pattern.charAt(i) === "}") return Number(minText) > 1;
  if (pattern.charAt(i) !== ",") return false;

  i += 1;
  let maxText = "";
  while (i < pattern.length && isAsciiDigit(pattern.charAt(i))) {
    maxText += pattern.charAt(i);
    i += 1;
  }
  if (pattern.charAt(i) !== "}") return false;
  if (maxText.length === 0) return true;
  return Number(maxText) > 1;
}

export function regexCharacterClassEnd(pattern: string, openIndex: number): number {
  for (let i = openIndex + 1; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "]") return i;
  }
  return pattern.length - 1;
}

export function isRegexAtomChar(ch: string): boolean {
  return ch !== "" && !"|^$*+?{}()".includes(ch);
}

export function hasQuantifiedAtom(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      if (regexQuantifierLength(pattern, i + 2) > 0) return true;
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = regexCharacterClassEnd(pattern, i);
      if (regexQuantifierLength(pattern, end + 1) > 0) return true;
      i = end;
      continue;
    }
    if (ch === ")" && regexQuantifierLength(pattern, i + 1) > 0) {
      return true;
    }
    if (isRegexAtomChar(ch) && regexQuantifierLength(pattern, i + 1) > 0) {
      return true;
    }
  }
  return false;
}

export function regexGroupBodyStart(pattern: string, openIndex: number): number {
  if (pattern.charAt(openIndex + 1) !== "?") return openIndex + 1;

  const kind = pattern.charAt(openIndex + 2);
  if (kind === ":" || kind === "=" || kind === "!") return openIndex + 3;
  if (kind !== "<") return openIndex + 2;

  const lookbehindKind = pattern.charAt(openIndex + 3);
  if (lookbehindKind === "=" || lookbehindKind === "!") return openIndex + 4;

  const namedGroupEnd = pattern.indexOf(">", openIndex + 3);
  return namedGroupEnd === -1 ? openIndex + 2 : namedGroupEnd + 1;
}

export function regexGroupEnd(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i = regexCharacterClassEnd(pattern, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return pattern.length - 1;
}

export function regexTopLevelAlternatives(pattern: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let depth = 0;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i = regexCharacterClassEnd(pattern, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (ch === "|" && depth === 0) {
      alternatives.push(pattern.slice(start, i));
      start = i + 1;
    }
  }

  alternatives.push(pattern.slice(start));
  return alternatives;
}

export function regexAtomTokens(pattern: string): string[] {
  const tokens: string[] = [];

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      tokens.push(pattern.slice(i, Math.min(i + 2, pattern.length)));
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = regexCharacterClassEnd(pattern, i);
      tokens.push(pattern.slice(i, end + 1));
      i = end;
      continue;
    }
    if (ch === "(") {
      const end = regexGroupEnd(pattern, i);
      tokens.push("(group)");
      i = end;
      continue;
    }
    if (ch === "^" || ch === "$") continue;
    tokens.push(ch);
  }

  return tokens;
}

export function regexTokensSharePrefix(a: readonly string[], b: readonly string[]): boolean {
  const len = Math.min(a.length, b.length);
  if (len === 0) return true;
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function hasAmbiguousAlternation(pattern: string): boolean {
  const alternatives = regexTopLevelAlternatives(pattern);
  if (alternatives.length > 1) {
    const tokenized = alternatives.map(regexAtomTokens);
    for (let i = 0; i < tokenized.length; i += 1) {
      for (let j = i + 1; j < tokenized.length; j += 1) {
        if (regexTokensSharePrefix(tokenized[i]!, tokenized[j]!)) return true;
      }
    }
  }

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i = regexCharacterClassEnd(pattern, i);
      continue;
    }
    if (ch !== "(") continue;

    const end = regexGroupEnd(pattern, i);
    const bodyStart = regexGroupBodyStart(pattern, i);
    if (bodyStart < end && hasAmbiguousAlternation(pattern.slice(bodyStart, end))) {
      return true;
    }
    i = end;
  }

  return false;
}

export function hasUnsafeRepeatedGroup(pattern: string): boolean {
  const groups: Array<{ bodyStart: number }> = [];

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i = regexCharacterClassEnd(pattern, i);
      continue;
    }
    if (ch === "(") {
      groups.push({ bodyStart: regexGroupBodyStart(pattern, i) });
      continue;
    }
    if (ch !== ")") continue;

    const group = groups.pop();
    const body = group === undefined ? "" : pattern.slice(group.bodyStart, i);
    if (
      group !== undefined &&
      regexQuantifierCanRepeat(pattern, i + 1) &&
      (hasQuantifiedAtom(body) || hasAmbiguousAlternation(body))
    ) {
      return true;
    }
  }

  return false;
}

export function splitHeadingPath(section: string): string[] {
  return section.split("/").map((s) => s.trim()).filter(Boolean);
}

export function assertMarkdownSectionListPath(relativePath: string): void {
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw new Error(`Not a markdown note: ${relativePath}`);
  }
}

export function sectionListCacheKey(vaultPath: string, notePath: string): string {
  return `${path.resolve(vaultPath)}\0${notePath}`;
}

export async function getSectionListSignature(
  vaultPath: string,
  notePath: string,
): Promise<{ fullPath: string; size: number; mtimeMs: number }> {
  assertMarkdownSectionListPath(notePath);
  let opened: Awaited<ReturnType<typeof openVaultFileForRead>> | undefined;
  try {
    opened = await openVaultFileForRead(vaultPath, notePath);
    assertNoteFileSize(notePath, opened.stats.size);
    return { fullPath: opened.fullPath, size: opened.stats.size, mtimeMs: opened.stats.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await readNote(vaultPath, notePath);
    }
    throw err;
  } finally {
    await opened?.handle.close();
  }
}

export function renderSectionList(notePath: string, content: string): string {
  const headings = parseHeadings(content);
  if (headings.length === 0) return `No headings in ${displaySectionValue(notePath)}`;
  const lines = [`${headings.length} heading(s) in ${displaySectionValue(notePath)}:`, ""];
  for (const h of headings) {
    lines.push(`${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${displaySectionValue(h.text)}`);
  }
  return lines.join("\n");
}

export async function readSectionListCached(vaultPath: string, notePath: string): Promise<string> {
  const signature = await getSectionListSignature(vaultPath, notePath);
  const key = sectionListCacheKey(vaultPath, notePath);
  const cached = sectionListCache.get(key);
  if (
    cached &&
    cached.fullPath === signature.fullPath &&
    cached.size === signature.size &&
    cached.mtimeMs === signature.mtimeMs
  ) {
    sectionListCache.delete(key);
    sectionListCache.set(key, cached);
    return cached.text;
  }

  let read: Awaited<ReturnType<typeof readVaultTextFile>> | undefined;
  try {
    read = await readVaultTextFile(vaultPath, notePath);
    assertNoteFileSize(notePath, read.stats.size);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Note not found: ${notePath}`, { cause: err });
    }
    throw err;
  }
  if (!read) throw new Error(`Note not found: ${notePath}`);
  const text = renderSectionList(notePath, read.content);
  sectionListCache.set(key, {
    fullPath: read.fullPath,
    size: read.stats.size,
    mtimeMs: read.stats.mtimeMs,
    text,
  });
  while (sectionListCache.size > SECTION_LIST_CACHE_LIMIT) {
    const oldestKey = sectionListCache.keys().next().value;
    if (oldestKey === undefined) break;
    sectionListCache.delete(oldestKey);
  }
  return text;
}

export function invalidateSectionListCache(vaultPath: string, notePath: string): void {
  sectionListCache.delete(sectionListCacheKey(vaultPath, notePath));
}
