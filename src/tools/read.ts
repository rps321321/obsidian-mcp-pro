import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { searchInContents, readNote, listNotes, getNoteStats, resolveVaultPathSafe } from "../lib/vault.js";
import { readAllCached } from "../lib/index-cache.js";
import { sanitizeError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { mapConcurrent } from "../lib/concurrency.js";
import { formatMomentDate } from "../lib/dates.js";
import { parseFrontmatter, extractTags, extractAliases } from "../lib/markdown.js";
import { findSection, findBlockById, stripBlockId } from "../lib/sections.js";
import { getDailyNoteConfig } from "../config.js";

export function registerReadTools(server: McpServer, vaultPath: string): void {
  function errorResult(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true as const };
  }

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      description:
        "Full-text search across all notes in the vault. Returns matching note paths grouped with the line numbers and snippet content of each hit. Use to locate notes containing a phrase, keyword, or code fragment; pair with get_note to retrieve full bodies.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Literal search string matched against note body text (not regex)"),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, match case exactly; otherwise case-insensitive (default: false)"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(20)
          .describe("Maximum number of matching notes to return (1-500, default: 20)"),
        folder: z
          .string()
          .optional()
          .describe("Restrict search to this folder relative to the vault root (omit to search entire vault)"),
      },
    },
    async ({ query, caseSensitive, maxResults, folder }) => {
      try {
        // Pull notes via the mtime cache so repeat searches with hot files
        // skip re-reads. The pure matcher (`searchInContents`) does the
        // line-level scan on the in-memory map.
        const notes = await listNotes(vaultPath, folder);
        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("search_notes: note read failed", { note, err });
        });
        const results = searchInContents(notes, contents, query, {
          caseSensitive,
          maxResults,
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}"`,
              },
            ],
          };
        }

        const lines: string[] = [
          `Found ${results.length} result(s) for "${query}":`,
          "",
        ];

        for (const result of results) {
          lines.push(`## ${result.relativePath}`);
          for (const match of result.matches) {
            lines.push(`  Line ${match.line}: ${match.content}`);
          }
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        log.error("search_notes failed", { tool: "search_notes", err: err as Error });
        return errorResult(`Error searching notes: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_note",
    {
      title: "Get Note",
      description:
        "Read a note in full or as a fragment. With no fragment options, returns parsed frontmatter (as a labeled header), a flat list of inline #tags, and the body. With `section`, returns just the body under that heading (path-form like 'Tasks/Today' is supported). With `block`, returns the paragraph or block tagged `^id`. With `lines`, returns the inclusive 1-indexed line range. Fragment modes skip the frontmatter/tag header and return raw text — use them to keep token usage tight on long notes.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Relative path from vault root to the note (e.g., 'folder/note.md'). Extension required."),
        section: z
          .string()
          .optional()
          .describe("Heading path (e.g., 'Tasks' or 'Project A/Status'). Returns just that section's body."),
        block: z
          .string()
          .optional()
          .describe("Block id (without the leading `^`). Returns just the paragraph or block tagged with that id."),
        lines: z
          .string()
          .regex(/^\d+(-\d+)?$/, "Must be N or N-M (1-indexed, inclusive)")
          .optional()
          .describe("Line range, 1-indexed and inclusive (e.g., '10-25' or '42'). Returns just those lines."),
      },
    },
    async ({ path: notePath, section, block, lines }) => {
      try {
        const content = await readNote(vaultPath, notePath);

        // Fragment modes are mutually exclusive — picking one skips the
        // frontmatter/tag header and returns raw text. Mode order: section
        // first (most user-facing), then block, then lines.
        if (section) {
          const headingPath = section.split("/").map((s) => s.trim()).filter(Boolean);
          const found = findSection(content, headingPath);
          if (!found) {
            return errorResult(`Section not found: "${section}" in ${notePath}`);
          }
          return {
            content: [
              {
                type: "text" as const,
                text: content.slice(found.start, found.end),
              },
            ],
          };
        }

        if (block) {
          const found = findBlockById(content, block);
          if (!found) {
            return errorResult(`Block not found: "^${block}" in ${notePath}`);
          }
          return {
            content: [
              {
                type: "text" as const,
                text: stripBlockId(content.slice(found.start, found.end)),
              },
            ],
          };
        }

        if (lines) {
          const allLines = content.split("\n");
          const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
          if (!m) return errorResult(`Invalid lines format: "${lines}"`);
          const a = Math.max(1, Number(m[1]));
          const b = m[2] ? Math.max(a, Number(m[2])) : a;
          if (a > allLines.length) {
            return errorResult(`Line ${a} is past end of file (${allLines.length} lines)`);
          }
          const slice = allLines.slice(a - 1, Math.min(b, allLines.length));
          return {
            content: [{ type: "text" as const, text: slice.join("\n") }],
          };
        }

        const { data: frontmatterData, content: bodyContent } = parseFrontmatter(content);

        const header: string[] = [];
        if (Object.keys(frontmatterData).length > 0) {
          header.push("--- Frontmatter ---");
          for (const [key, value] of Object.entries(frontmatterData)) {
            header.push(`${key}: ${JSON.stringify(value)}`);
          }
          header.push("--- End Frontmatter ---");
          header.push("");
        }

        const tags = extractTags(content);
        if (tags.length > 0) {
          header.push(`Tags: ${tags.join(", ")}`);
          header.push("");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: header.length > 0
                ? header.join("\n") + bodyContent
                : content,
            },
          ],
        };
      } catch (err) {
        log.error("get_note failed", { tool: "get_note", err: err as Error });
        return errorResult(`Error reading note: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "list_notes",
    {
      title: "List Notes",
      description:
        "Enumerate every markdown note in the vault (or a single folder), returning a sorted list of relative paths along with the total count. Truncates output to `limit` entries but still reports the total. Use to browse vault structure, build a file picker, or enumerate targets for batch processing.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder relative to vault root to restrict the listing (omit to list the entire vault)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .default(50)
          .describe("Maximum number of note paths to return (1-10000, default: 50). The full total count is still reported separately."),
      },
    },
    async ({ folder, limit }) => {
      try {
        const notes = await listNotes(vaultPath, folder);
        const limited = notes.slice(0, limit);
        const totalCount = notes.length;

        const lines: string[] = [
          `Found ${totalCount} note(s)${folder ? ` in "${folder}"` : ""}${totalCount > limit ? ` (showing first ${limit})` : ""}:`,
          "",
          ...limited,
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        log.error("list_notes failed", { tool: "list_notes", err: err as Error });
        return errorResult(`Error listing notes: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_daily_note",
    {
      title: "Get Daily Note",
      description:
        "Read the daily note for today or for a specific date, resolved via the vault's configured daily-note folder and filename format. Returns the note path, parsed frontmatter (as a labeled header block), and body. Errors if no daily note exists for that date — use create_daily_note to create one.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
          .optional()
          .describe("Target date in YYYY-MM-DD format (defaults to today's local date)"),
      },
    },
    async ({ date }) => {
      try {
        const config = await getDailyNoteConfig(vaultPath);
        const targetDate = date ?? new Date().toISOString().slice(0, 10);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          return errorResult(`Invalid date format: "${targetDate}". Use YYYY-MM-DD.`);
        }
        const parsed = new Date(`${targetDate}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) {
          return errorResult(`Invalid date: "${targetDate}".`);
        }

        // Build the filename using moment-style tokens (YYYY, MMM, ddd, etc).
        let filename = formatMomentDate(parsed, config.format);
        if (!filename.endsWith(".md")) {
          filename += ".md";
        }

        const notePath = config.folder
          ? `${config.folder}/${filename}`
          : filename;

        let content: string;
        try {
          content = await readNote(vaultPath, notePath);
        } catch {
          return errorResult(`Daily note not found for ${targetDate} (expected at "${notePath}")`);
        }

        const { data: dailyFrontmatter, content: dailyBody } = parseFrontmatter(content);
        const header: string[] = [
          `Daily Note: ${targetDate}`,
          `Path: ${notePath}`,
          "",
        ];

        if (Object.keys(dailyFrontmatter).length > 0) {
          header.push("--- Frontmatter ---");
          for (const [key, value] of Object.entries(dailyFrontmatter)) {
            header.push(`${key}: ${JSON.stringify(value)}`);
          }
          header.push("--- End Frontmatter ---");
          header.push("");
        }

        return {
          content: [
            { type: "text" as const, text: header.join("\n") + dailyBody },
          ],
        };
      } catch (err) {
        log.error("get_daily_note failed", { tool: "get_daily_note", err: err as Error });
        return errorResult(`Error reading daily note: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "search_by_frontmatter",
    {
      title: "Search by Frontmatter",
      description:
        "Find notes whose YAML frontmatter contains a given property/value pair. Comparison is case-insensitive; for array-valued properties, a match is declared if any element matches. Returns matching note paths with their full frontmatter. Use to filter notes by metadata like status, type, or tags stored in frontmatter.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        property: z
          .string()
          .min(1)
          .describe("Frontmatter key to look up (e.g., 'status', 'type', 'author')"),
        value: z
          .string()
          .min(1)
          .describe("Value to match against the property (case-insensitive; matches any array element)"),
        folder: z
          .string()
          .optional()
          .describe("Restrict search to this folder relative to the vault root (omit to search entire vault)"),
      },
    },
    async ({ property, value, folder }) => {
      try {
        const notes = await listNotes(vaultPath, folder);
        const valueLower = value.toLowerCase();

        // Fan out reads at the same concurrency used by `search_notes` and
        // tag scans. The previous sequential loop paid one `realpath` syscall
        // per note per query — unworkable on 10k+ note vaults. Per-note
        // failures are logged and dropped so one unreadable file can't abort
        // the whole scan.
        type Hit = { path: string; frontmatter: Record<string, unknown> };
        const perNote = await mapConcurrent<string, Hit | undefined>(
          notes,
          16,
          async (notePath) => {
            const content = await readNote(vaultPath, notePath);
            const { data: frontmatterData } = parseFrontmatter(content);
            const propValue = frontmatterData[property];
            if (propValue === undefined) return undefined;

            const stringified = Array.isArray(propValue)
              ? propValue.map(String)
              : [String(propValue)];
            const isMatch = stringified.some((v) => v.toLowerCase() === valueLower);
            return isMatch ? { path: notePath, frontmatter: frontmatterData } : undefined;
          },
          (err, notePath) => {
            log.warn("search_by_frontmatter: note read failed", {
              note: notePath,
              err: err as Error,
            });
          },
        );

        const matches: Hit[] = [];
        for (const entry of perNote) {
          if (entry) matches.push(entry);
        }

        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No notes found with frontmatter "${property}" matching "${value}"`,
              },
            ],
          };
        }

        const lines: string[] = [
          `Found ${matches.length} note(s) where "${property}" matches "${value}":`,
          "",
        ];

        for (const match of matches) {
          lines.push(`## ${match.path}`);
          for (const [key, val] of Object.entries(match.frontmatter)) {
            lines.push(`  ${key}: ${JSON.stringify(val)}`);
          }
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        log.error("search_by_frontmatter failed", { tool: "search_by_frontmatter", err: err as Error });
        return errorResult(`Error searching by frontmatter: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_recent_notes",
    {
      title: "Get Recent Notes",
      description:
        "List notes ordered by most-recently-modified first. Optional `since` filter accepts an ISO date (e.g. '2026-04-01') or a relative span ('7d', '24h', '2w'); only notes modified at or after that time are returned. Use to surface what you've been working on, build a 'what changed this week' digest, or pick targets for review.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(20)
          .describe("Maximum number of notes to return (1-1000, default: 20)."),
        since: z
          .string()
          .optional()
          .describe("Filter to notes modified at or after this point. Accepts ISO 8601 (YYYY-MM-DD or full timestamp) or a relative span like '7d', '24h', '2w'."),
        folder: z
          .string()
          .optional()
          .describe("Restrict to notes within this folder (relative to vault root). Omit to scan the entire vault."),
      },
    },
    async ({ limit, since, folder }) => {
      try {
        const sinceMs = since ? parseSince(since) : null;
        if (since && sinceMs === null) {
          return errorResult(`Invalid 'since' value: "${since}". Use ISO date or relative span like '7d', '24h', '2w'.`);
        }
        const notes = await listNotes(vaultPath, folder);

        // Stat each note for mtime. fs.stat is one syscall and bypasses the
        // content cache deliberately — we don't need bodies, only timestamps.
        type Row = { path: string; mtimeMs: number };
        const stats = await mapConcurrent<string, Row | undefined>(
          notes,
          16,
          async (notePath) => {
            try {
              const fullPath = await resolveVaultPathSafe(vaultPath, notePath);
              const st = await fs.stat(fullPath);
              return { path: notePath, mtimeMs: st.mtimeMs };
            } catch {
              return undefined;
            }
          },
        );

        const rows: Row[] = [];
        for (const r of stats) {
          if (!r) continue;
          if (sinceMs !== null && r.mtimeMs < sinceMs) continue;
          rows.push(r);
        }
        rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const top = rows.slice(0, limit);

        if (top.length === 0) {
          return { content: [{ type: "text" as const, text: since ? `No notes modified since ${since}.` : "No notes in the vault." }] };
        }

        const lines: string[] = [
          `${rows.length} note(s)${since ? ` modified since ${since}` : ""}${rows.length > limit ? ` (showing first ${limit})` : ""}:`,
          "",
        ];
        for (const r of top) {
          const iso = new Date(r.mtimeMs).toISOString();
          lines.push(`- ${r.path}  (${iso})`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        log.error("get_recent_notes failed", { tool: "get_recent_notes", err: err as Error });
        return errorResult(`Error listing recent notes: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_vault_stats",
    {
      title: "Get Vault Stats",
      description:
        "Return a quick health snapshot of the vault: note count, total bytes, total words, unique tag count, untagged-note count, and the most-recently-modified note. Useful for dashboards and 'is this vault healthy?' checks. Reads through the mtime cache so repeat calls are cheap.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Restrict stats to this folder (relative to vault root). Omit for whole-vault stats."),
      },
    },
    async ({ folder }) => {
      try {
        const notes = await listNotes(vaultPath, folder);
        if (notes.length === 0) {
          return { content: [{ type: "text" as const, text: folder ? `No notes in "${folder}"` : "Vault is empty." }] };
        }
        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("get_vault_stats: note read failed", { note, err });
        });

        let totalBytes = 0;
        let totalWords = 0;
        let untagged = 0;
        const tagSet = new Set<string>();
        for (const notePath of notes) {
          const content = contents.get(notePath);
          if (content === undefined) continue;
          totalBytes += Buffer.byteLength(content, "utf-8");
          // Word count: parse frontmatter out so YAML keys don't inflate
          // the count, then split body on whitespace.
          const { content: body } = parseFrontmatter(content);
          const matches = body.match(/\S+/g);
          totalWords += matches ? matches.length : 0;
          const tags = extractTags(content);
          if (tags.length === 0) untagged++;
          for (const t of tags) tagSet.add(t.toLowerCase());
        }

        // Most recent note via fs.stat — keep this independent of the cache
        // so it's accurate even if the cache hasn't been touched yet.
        let mostRecent: { path: string; mtimeMs: number } | null = null;
        const stats = await mapConcurrent<string, { path: string; mtimeMs: number } | undefined>(
          notes,
          16,
          async (notePath) => {
            try {
              const st = await getNoteStats(vaultPath, notePath);
              if (!st.modified) return undefined;
              return { path: notePath, mtimeMs: st.modified.getTime() };
            } catch {
              return undefined;
            }
          },
        );
        for (const s of stats) {
          if (!s) continue;
          if (!mostRecent || s.mtimeMs > mostRecent.mtimeMs) mostRecent = s;
        }

        const avgBytes = Math.round(totalBytes / notes.length);
        const avgWords = Math.round(totalWords / notes.length);
        const untaggedPct = ((untagged / notes.length) * 100).toFixed(1);
        const lines = [
          `Vault stats${folder ? ` (folder: ${folder})` : ""}`,
          "",
          `  Notes:           ${notes.length}`,
          `  Total bytes:     ${totalBytes.toLocaleString()}`,
          `  Total words:     ${totalWords.toLocaleString()}`,
          `  Avg bytes/note:  ${avgBytes.toLocaleString()}`,
          `  Avg words/note:  ${avgWords.toLocaleString()}`,
          `  Unique tags:     ${tagSet.size}`,
          `  Untagged notes:  ${untagged} (${untaggedPct}%)`,
          mostRecent
            ? `  Most recent:     ${mostRecent.path} (${new Date(mostRecent.mtimeMs).toISOString()})`
            : `  Most recent:     (none)`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        log.error("get_vault_stats failed", { tool: "get_vault_stats", err: err as Error });
        return errorResult(`Error gathering vault stats: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "resolve_alias",
    {
      title: "Resolve Alias",
      description:
        "Find every note whose frontmatter `aliases:` field contains the given name (case-insensitive). With `includeBasename: true`, also matches notes whose filename (without `.md`) equals the name — Obsidian's resolution fallback when no alias matches. Use to translate a human-friendly title like 'My Project' into the actual note path before calling get_note.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Alias or display name to resolve, e.g. 'My Project'."),
        includeBasename: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), also match notes whose filename (without extension) equals `name`."),
      },
    },
    async ({ name, includeBasename }) => {
      try {
        const target = name.trim().toLowerCase();
        if (!target) return errorResult("name must not be empty");
        const notes = await listNotes(vaultPath);
        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("resolve_alias: note read failed", { note, err });
        });

        const aliasMatches: string[] = [];
        const basenameMatches: string[] = [];
        for (const notePath of notes) {
          if (includeBasename) {
            const basename = path.basename(notePath, path.extname(notePath)).toLowerCase();
            if (basename === target) basenameMatches.push(notePath);
          }
          const content = contents.get(notePath);
          if (content === undefined) continue;
          const aliases = extractAliases(content);
          if (aliases.some((a) => a.toLowerCase() === target)) aliasMatches.push(notePath);
        }

        const total = aliasMatches.length + basenameMatches.length;
        if (total === 0) {
          return { content: [{ type: "text" as const, text: `No alias or basename match for "${name}"` }] };
        }

        const lines: string[] = [`Matches for "${name}":`, ""];
        if (aliasMatches.length > 0) {
          lines.push(`Alias matches (${aliasMatches.length}):`);
          for (const p of aliasMatches) lines.push(`  - ${p}`);
        }
        if (basenameMatches.length > 0) {
          if (aliasMatches.length > 0) lines.push("");
          lines.push(`Basename matches (${basenameMatches.length}):`);
          for (const p of basenameMatches) lines.push(`  - ${p}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        log.error("resolve_alias failed", { tool: "resolve_alias", err: err as Error });
        return errorResult(`Error resolving alias: ${sanitizeError(err)}`);
      }
    },
  );
}

/**
 * Parse a `since` filter into milliseconds-since-epoch. Accepts ISO 8601
 * (YYYY-MM-DD or full timestamp) or relative spans of the form `<n><unit>`
 * where unit is `h` (hours), `d` (days), or `w` (weeks). Returns null on
 * unrecognized input so callers can surface a precise error.
 */
function parseSince(input: string): number | null {
  const trimmed = input.trim();
  // Relative span: 7d, 24h, 2w
  const rel = trimmed.match(/^(\d+)\s*(h|d|w)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "h" ? 3600_000 : unit === "d" ? 86_400_000 : 7 * 86_400_000;
    return Date.now() - n * ms;
  }
  // ISO date: YYYY-MM-DD or full timestamp.
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}
