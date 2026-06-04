import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { readNote, resolveVaultPathSafe, updateNote } from "../lib/vault.js";
import {
  findSection,
  findBlockById,
  parseHeadings,
  replaceSectionBody,
  insertAfterHeading,
} from "../lib/sections.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import { log } from "../lib/logger.js";

const SECTION_LIST_CACHE_LIMIT = 16;

interface SectionListCacheEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
  text: string;
}

const sectionListCache = new Map<string, SectionListCacheEntry>();

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Escape control characters before embedding values in section-tool display text. */
const displaySectionValue = escapeControlChars;

function splitHeadingPath(section: string): string[] {
  return section.split("/").map((s) => s.trim()).filter(Boolean);
}

function sectionListCacheKey(vaultPath: string, notePath: string): string {
  return `${path.resolve(vaultPath)}\0${notePath}`;
}

async function getSectionListSignature(
  vaultPath: string,
  notePath: string,
): Promise<{ fullPath: string; size: number; mtimeMs: number }> {
  const fullPath = await resolveVaultPathSafe(vaultPath, notePath);
  try {
    const stats = await fs.stat(fullPath);
    return { fullPath, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await readNote(vaultPath, notePath);
    }
    throw err;
  }
}

function renderSectionList(notePath: string, content: string): string {
  const headings = parseHeadings(content);
  if (headings.length === 0) return `No headings in ${displaySectionValue(notePath)}`;
  const lines = [`${headings.length} heading(s) in ${displaySectionValue(notePath)}:`, ""];
  for (const h of headings) {
    lines.push(`${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${displaySectionValue(h.text)}`);
  }
  return lines.join("\n");
}

async function readSectionListCached(vaultPath: string, notePath: string): Promise<string> {
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

  let content: string;
  try {
    content = await fs.readFile(signature.fullPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Note not found: ${notePath}`, { cause: err });
    }
    throw err;
  }
  const text = renderSectionList(notePath, content);
  sectionListCache.set(key, { ...signature, text });
  while (sectionListCache.size > SECTION_LIST_CACHE_LIMIT) {
    const oldestKey = sectionListCache.keys().next().value;
    if (oldestKey === undefined) break;
    sectionListCache.delete(oldestKey);
  }
  return text;
}

function invalidateSectionListCache(vaultPath: string, notePath: string): void {
  sectionListCache.delete(sectionListCacheKey(vaultPath, notePath));
}

export function registerSectionTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "update_section",
    {
      title: "Update Section",
      description:
        "Replace the body of a specific section (everything between a heading and the next heading at any level). The heading line itself is preserved. `section` is a heading path: `'Tasks'`, `'Project A/Status'`, etc. - case-insensitive and whitespace-tolerant. Use this instead of rewriting the whole file when you only need to update one section.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path to the note (e.g., 'folder/note.md'). Extension required."),
        section: z
          .string()
          .min(1)
          .describe("Heading path identifying the section to replace (e.g., 'Tasks' or 'Daily/Today')."),
        newBody: z
          .string()
          .describe("Replacement body content. The heading line itself is kept intact."),
      },
    },
    async ({ path: notePath, section, newBody }) => {
      try {
        const headingPath = splitHeadingPath(section);
        if (headingPath.length === 0) return errorResult("section must not be empty");

        let resolvedHeading = "";
        let bodyBytes = 0;
        await updateNote(vaultPath, notePath, (existing) => {
          const found = findSection(existing, headingPath);
          if (!found) {
            throw new Error(`Section not found: "${section}"`);
          }
          resolvedHeading = found.heading.text;
          const updated = replaceSectionBody(existing, found, newBody);
          // Count bytes, not UTF-16 code units, so the message is accurate
          // for unicode bodies. `string.length` would understate emoji
          // and overstate astral characters by a factor of two.
          bodyBytes = Buffer.byteLength(newBody, "utf-8");
          return updated;
        });
        invalidateSectionListCache(vaultPath, notePath);
        return textResult(
          `Updated section "${displaySectionValue(resolvedHeading)}" in ${displaySectionValue(notePath)} (${bodyBytes} bytes of new body)`,
        );
      } catch (err) {
        log.error("update_section failed", { tool: "update_section", err: err as Error });
        return errorResult(`Error updating section: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "insert_at_section",
    {
      title: "Insert at Section",
      description:
        "Insert content into a specific section without replacing it. `position` controls where: 'before' inserts above the heading, 'after-heading' inserts immediately under the heading line (at the top of the section body), 'append' inserts at the end of the section's body just before the next heading. Use to add a new bullet or paragraph without rewriting the section.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
        section: z.string().min(1).describe("Heading path identifying the section."),
        content: z.string().describe("Content to insert. A trailing newline is normalized."),
        position: z
          .enum(["before", "after-heading", "append"])
          .default("append")
          .describe("Insert before the heading line, immediately after the heading, or at the end of the section body."),
      },
    },
    async ({ path: notePath, section, content, position }) => {
      try {
        const headingPath = splitHeadingPath(section);
        if (headingPath.length === 0) return errorResult("section must not be empty");

        let resolvedHeading = "";
        await updateNote(vaultPath, notePath, (existing) => {
          const found = findSection(existing, headingPath);
          if (!found) {
            throw new Error(`Section not found: "${section}"`);
          }
          resolvedHeading = found.heading.text;
          if (position === "after-heading") {
            return insertAfterHeading(existing, found, content);
          }
          if (position === "before") {
            const before = existing.slice(0, found.start);
            const after = existing.slice(found.start);
            const trailing = content.endsWith("\n") ? "" : "\n";
            return before + content + trailing + after;
          }
          // append: insert at end of section body, before the next heading
          const before = existing.slice(0, found.end);
          const after = existing.slice(found.end);
          let payload = content;
          // Make sure there's a leading newline if the section body didn't
          // already end on one (so we don't fuse with the prior line).
          if (!before.endsWith("\n")) payload = "\n" + payload;
          if (!payload.endsWith("\n")) payload += "\n";
          return before + payload + after;
        });
        invalidateSectionListCache(vaultPath, notePath);
        return textResult(
          `Inserted ${Buffer.byteLength(content, "utf-8")} bytes into "${displaySectionValue(resolvedHeading)}" (${position}) in ${displaySectionValue(notePath)}`,
        );
      } catch (err) {
        log.error("insert_at_section failed", { tool: "insert_at_section", err: err as Error });
        return errorResult(`Error inserting at section: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "list_sections",
    {
      title: "List Sections",
      description:
        "List all headings in a note as a tree of paths (with depth). Useful for discovering valid `section` arguments before calling get_note, update_section, or insert_at_section.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
      },
    },
    async ({ path: notePath }) => {
      try {
        return textResult(await readSectionListCached(vaultPath, notePath));
      } catch (err) {
        log.error("list_sections failed", { tool: "list_sections", err: err as Error });
        return errorResult(`Error listing sections: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "replace_in_note",
    {
      title: "Replace in Note",
      description:
        "Search-and-replace within a single note. Supports literal strings or regex patterns. With `expectedCount`, the operation refuses to commit unless that many matches are present, guarding against accidental over-replacement when an LLM drafts a pattern that's too broad. Returns the count of replacements made.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
        find: z.string().min(1).describe("Literal string (default) or regex pattern to match."),
        replace: z.string().describe("Replacement text. With `regex: true`, supports $1, $2 backreferences."),
        regex: z.boolean().default(false).describe("Treat `find` as a JavaScript regex (multi-line, case-sensitive by default)."),
        flags: z.string().optional().describe("Regex flags (e.g., 'gi'). Defaults to 'g' so all matches are replaced."),
        expectedCount: z.number().int().min(0).optional().describe("If set, abort unless exactly this many matches are found."),
      },
    },
    async ({ path: notePath, find, replace, regex, flags, expectedCount }) => {
      // Defense in depth: arbitrary regex from LLM input is inherently risky.
      // The validation below caps obvious foot-guns (bad flags, huge patterns,
      // huge inputs) but true bulletproofing against catastrophic backtracking
      // requires a linear-time engine (re2) or running the match in a worker
      // thread we can kill. We do neither here, so callers should still treat
      // `regex: true` as a privileged operation.
      const FIND_MAX_LEN = 4096;
      const INPUT_MAX_LEN = 1_000_000;
      const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

      try {
        let pattern: RegExp;
        if (regex) {
          if (find.length > FIND_MAX_LEN) {
            return errorResult(
              `Error replacing in note: find pattern too long (${find.length} > ${FIND_MAX_LEN} chars). Use a more targeted pattern.`,
            );
          }
          const f = flags ?? "g";
          // Validate flags against a strict allowlist before we hand them to
          // the engine; reject duplicates and unknown chars with a clear msg.
          const seen = new Set<string>();
          for (const ch of f) {
            if (!ALLOWED_FLAGS.has(ch)) {
              return errorResult(
                `Error replacing in note: invalid regex flag '${displaySectionValue(ch)}'. Allowed flags: g, i, m, s, u, y.`,
              );
            }
            if (seen.has(ch)) {
              return errorResult(
                `Error replacing in note: duplicate regex flag '${displaySectionValue(ch)}'.`,
              );
            }
            seen.add(ch);
          }
          if (!f.includes("g")) {
            return errorResult(
              "Error replacing in note: regex flags must include 'g' for replace_in_note.",
            );
          }
          try {
            pattern = new RegExp(find, f);
          } catch (syntaxErr) {
            return errorResult(
              `Error replacing in note: invalid regex pattern: ${sanitizeError(syntaxErr)}`,
            );
          }
        } else {
          const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          pattern = new RegExp(escaped, "g");
        }

        let count = 0;
        await updateNote(vaultPath, notePath, (existing) => {
          // Cap the input size we apply the regex to — refusing the work is
          // far better than holding the per-file write lock while the engine
          // backtracks against a pathological pattern.
          if (existing.length > INPUT_MAX_LEN) {
            throw new Error(
              `note is too large for replace_in_note (${existing.length} > ${INPUT_MAX_LEN} chars). Use a more targeted tool.`,
            );
          }
          const matches = existing.match(pattern);
          count = matches ? matches.length : 0;
          if (expectedCount !== undefined && count !== expectedCount) {
            throw new Error(
              `Match-count check failed: expected ${expectedCount}, found ${count}. No changes written.`,
            );
          }
          if (count === 0) return existing;
          return regex
            ? existing.replace(pattern, replace)
            : existing.replace(pattern, () => replace);
        });
        invalidateSectionListCache(vaultPath, notePath);
        return textResult(
          count === 0
            ? `No matches in ${displaySectionValue(notePath)} - file unchanged.`
            : `Replaced ${count} match(es) in ${displaySectionValue(notePath)}.`,
        );
      } catch (err) {
        log.error("replace_in_note failed", { tool: "replace_in_note", err: err as Error });
        return errorResult(`Error replacing in note: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "edit_block",
    {
      title: "Edit Block",
      description:
        "Replace the content of a block tagged with `^id`. The trailing `^id` anchor is preserved on the last line of the new content so existing transclusions (`![[note#^id]]`) keep working. Use to update a single paragraph or list item that other notes reference.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
        block: z
          .string()
          .min(1)
          // Normalize so callers passing `^myid` are treated identically to
          // `myid`. The trailing length check after stripping prevents `"^"`
          // alone from sneaking through the min(1) at the wire.
          .transform((s) => s.replace(/^\^+/, ""))
          .refine((s) => s.length > 0, { message: "block id must not be empty after stripping leading '^'" })
          .describe("Block id with or without the leading `^` (e.g. `myid` or `^myid`)."),
        newContent: z.string().describe("Replacement content. The `^id` anchor is appended automatically."),
      },
    },
    async ({ path: notePath, block, newContent }) => {
      try {
        await updateNote(vaultPath, notePath, (existing) => {
          const found = findBlockById(existing, block);
          if (!found) throw new Error(`Block not found: "^${block}"`);
          const before = existing.slice(0, found.start);
          const after = existing.slice(found.end);
          // Drop any trailing newline on newContent — we'll re-add it after
          // the block id so the surrounding line structure is identical.
          const body = newContent.replace(/\n+$/, "");
          // Append the anchor as a separate token. Obsidian convention is
          // `<block content> ^id` on a single line, OR the anchor on its own
          // line for multi-line blocks. Single-line: append; multi-line: own line.
          const isMultiline = body.includes("\n");
          const replacement = isMultiline ? `${body}\n^${block}\n` : `${body} ^${block}\n`;
          return before + replacement + after;
        });
        invalidateSectionListCache(vaultPath, notePath);
        return textResult(`Updated block ^${displaySectionValue(block)} in ${displaySectionValue(notePath)}`);
      } catch (err) {
        log.error("edit_block failed", { tool: "edit_block", err: err as Error });
        return errorResult(`Error editing block: ${sanitizeError(err)}`);
      }
    },
  );
}
