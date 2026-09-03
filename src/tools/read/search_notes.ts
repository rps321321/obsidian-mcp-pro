import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchNotes } from "../../lib/vault.js";
import { defineTool, richText, text } from "../../lib/tool-seam.js";
import { escapeControlChars } from "./shared.js";

export function registerSearchNotesTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "search_notes",
      title: "Search Notes",
      description:
        "Full-text search across all notes in the vault. Ranks literal matches with title/path focus and repeated-line dampening, then returns matching note paths grouped with the line numbers and query-centered snippet content of each matching line. Use to locate notes containing a phrase, keyword, or code fragment; pair with get_note to retrieve full bodies.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            "Literal search string matched against note body text (not regex)"
          ),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, match case exactly; otherwise case-insensitive (default: false)"
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(20)
          .describe(
            "Maximum number of matching notes to return (1-500, default: 20)"
          ),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Restrict search to this folder relative to the vault root (omit to search entire vault)"
          ),
      },
    },
    async ({ query, caseSensitive, maxResults, folder }) => {
      const results = await searchNotes(vaultPath, query, {
        caseSensitive,
        maxResults,
        folder,
      });

      if (results.length === 0) {
        return text(`No results found for "${escapeControlChars(query)}"`);
      }

      return richText("search_notes paths and snippets", (b) => {
        b.trusted(
          `Found ${results.length} result(s) for "${escapeControlChars(query)}":`
        );
        b.trusted("");
        for (const result of results) {
          b.trusted("Result path:");
          b.untrusted(
            "search_notes result path",
            escapeControlChars(result.relativePath),
            "  "
          );
          for (const match of result.matches) {
            b.trusted(`  Line ${match.line}:`);
            b.untrusted(
              "search_notes snippet",
              escapeControlChars(match.content),
              "    "
            );
          }
          b.trusted("");
        }
      });
    }
  );
}
