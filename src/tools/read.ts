import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchNotes, readNote, listNotes, getNoteStats } from "../lib/vault.js";
import { parseFrontmatter, extractTags } from "../lib/markdown.js";
import { getDailyNoteConfig } from "../config.js";

export function registerReadTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "search_notes",
    {
      description: "Full-text search across all notes in the vault",
      inputSchema: {
        query: z.string().describe("Search query string"),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether the search should be case sensitive"),
        maxResults: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum number of results to return"),
        folder: z
          .string()
          .optional()
          .describe("Limit search to a specific folder"),
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching notes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_note",
    {
      description: "Read the full content of a note by its path",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the note within the vault"),
      },
    },
    async ({ path: notePath }) => {
      try {
        const content = await readNote(vaultPath, notePath);
        const { data: frontmatterData } = parseFrontmatter(content);

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
                ? header.join("\n") + content
                : content,
            },
          ],
        };
      } catch (err) {
        console.error("get_note error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading note: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "list_notes",
    {
      description: "List all notes in the vault or a specific folder",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder to list notes from (omit for entire vault)"),
        limit: z
          .number()
          .optional()
          .default(50)
          .describe("Maximum number of notes to return"),
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing notes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_daily_note",
    {
      description: "Get today's daily note or a specific date's daily note",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe(
            "Date in YYYY-MM-DD format (defaults to today)",
          ),
      },
    },
    async ({ date }) => {
      try {
        const config = getDailyNoteConfig(vaultPath);
        const targetDate = date ?? new Date().toISOString().slice(0, 10);

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
          return {
            content: [
              {
                type: "text" as const,
                text: `Daily note not found for ${targetDate} (expected at "${notePath}")`,
              },
            ],
          };
        }

        const { data: dailyFrontmatter } = parseFrontmatter(content);
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
            { type: "text" as const, text: header.join("\n") + content },
          ],
        };
      } catch (err) {
        console.error("get_daily_note error:", err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading daily note: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "search_by_frontmatter",
    {
      description: "Search notes by frontmatter property values",
      inputSchema: {
        property: z
          .string()
          .describe("Frontmatter property key to search for"),
        value: z.string().describe("Value to match against the property"),
        folder: z
          .string()
          .optional()
          .describe("Limit search to a specific folder"),
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching by frontmatter: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
