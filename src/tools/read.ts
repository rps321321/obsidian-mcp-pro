import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchNotes, readNote, listNotes, getNoteStats } from "../lib/vault.js";
import { parseFrontmatter, extractTags } from "../lib/markdown.js";
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
        const results = await searchNotes(vaultPath, query, {
          caseSensitive,
          maxResults,
          folder,
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
        console.error("search_notes error:", err);
        return errorResult(`Error searching notes: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "get_note",
    {
      title: "Get Note",
      description:
        "Read the full content of a single note, including its parsed YAML frontmatter (rendered as a labeled header block), a flat list of inline #tags, and the markdown body. Use to retrieve a specific note by exact path — for discovery across many notes, prefer search_notes, search_by_tag, or list_notes.",
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
      },
    },
    async ({ path: notePath }) => {
      try {
        const content = await readNote(vaultPath, notePath);
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
        console.error("get_note error:", err);
        return errorResult(`Error reading note: ${err instanceof Error ? err.message : String(err)}`);
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
        console.error("list_notes error:", err);
        return errorResult(`Error listing notes: ${err instanceof Error ? err.message : String(err)}`);
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

        // Build the filename from the configured format
        // Replace common date tokens with actual date parts
        const [year, month, day] = targetDate.split("-");
        let filename = config.format
          .replace("YYYY", year)
          .replace("MM", month)
          .replace("DD", day);

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
        console.error("get_daily_note error:", err);
        return errorResult(`Error reading daily note: ${err instanceof Error ? err.message : String(err)}`);
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
        const matches: Array<{
          path: string;
          frontmatter: Record<string, unknown>;
        }> = [];

        for (const notePath of notes) {
          let content: string;
          try {
            content = await readNote(vaultPath, notePath);
          } catch {
            console.error(
              `Failed to read note during frontmatter search: ${notePath}`,
            );
            continue;
          }

          const { data: frontmatterData } = parseFrontmatter(content);
          const propValue = frontmatterData[property];

          if (propValue === undefined) continue;

          const stringified = Array.isArray(propValue)
            ? propValue.map(String)
            : [String(propValue)];

          const isMatch = stringified.some(
            (v) => v.toLowerCase() === value.toLowerCase(),
          );

          if (isMatch) {
            matches.push({ path: notePath, frontmatter: frontmatterData });
          }
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
        console.error("search_by_frontmatter error:", err);
        return errorResult(`Error searching by frontmatter: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
