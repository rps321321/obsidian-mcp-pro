import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { log } from "../../lib/logger.js";
import { parseFrontmatter } from "../../lib/markdown.js";
import { defineTool, richText, text } from "../../lib/tool-seam.js";
import {
  displayReadValue,
  frontmatterValueForProperty,
  toSearchableString,
} from "./shared.js";

export function registerSearchByFrontmatterTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "search_by_frontmatter",
      title: "Search by Frontmatter",
      description:
        "Find notes whose YAML frontmatter contains a given property/value pair. Property names and values are matched case-insensitively; for array-valued properties, a match is declared if any element matches. Returns matching note paths with their full frontmatter. Use to filter notes by metadata like status, type, or tags stored in frontmatter.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        property: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Frontmatter key to look up, case-insensitively (e.g., 'status', 'type', 'author')"
          ),
        value: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            "Value to match against the property (case-insensitive; matches any array element)"
          ),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Restrict search to this folder relative to the vault root (omit to search entire vault)"
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe(
            "Maximum number of matching notes to return (1-500, default: 50)"
          ),
      },
    },
    async ({ property, value, folder, maxResults }) => {
      const notes = await listNotes(vaultPath, folder);
      const valueLower = value.toLowerCase();

      type Hit = { path: string; frontmatter: Record<string, unknown> };
      const allMatches: Hit[] = [];
      const { contents } = await readAllCached(
        vaultPath,
        notes,
        (note, err) => {
          log.warn("search_by_frontmatter: note read failed", { note, err });
        }
      );
      for (const notePath of notes) {
        const content = contents.get(notePath);
        if (content === undefined) continue;
        const { data: frontmatterData } = parseFrontmatter(content);
        const propValue = frontmatterValueForProperty(
          frontmatterData,
          property
        );
        if (propValue === undefined) continue;

        const stringified = Array.isArray(propValue)
          ? propValue.map(toSearchableString)
          : [toSearchableString(propValue)];
        const isMatch = stringified.some((v) => v.toLowerCase() === valueLower);
        if (isMatch)
          allMatches.push({ path: notePath, frontmatter: frontmatterData });
      }

      if (allMatches.length === 0) {
        return text(
          `No notes found with frontmatter "${displayReadValue(property)}" matching "${displayReadValue(value)}"`
        );
      }

      const totalMatches = allMatches.length;
      const truncated = totalMatches > maxResults;
      const matches = truncated ? allMatches.slice(0, maxResults) : allMatches;

      return richText("search_by_frontmatter paths and values", (b) => {
        b.trusted(
          `Found ${totalMatches} note(s) where "${displayReadValue(property)}" matches "${displayReadValue(value)}"${truncated ? ` (showing first ${maxResults})` : ""}:`
        );
        b.trusted("");
        for (const match of matches) {
          b.trusted("Result path:");
          b.untrusted(
            "search_by_frontmatter result path",
            displayReadValue(match.path),
            "  "
          );
          const frontmatterLines: string[] = [];
          for (const [key, val] of Object.entries(match.frontmatter)) {
            frontmatterLines.push(
              `${displayReadValue(key)}: ${displayReadValue(JSON.stringify(val) ?? "")}`
            );
          }
          if (frontmatterLines.length > 0) {
            b.untrusted(
              "search_by_frontmatter values",
              frontmatterLines.join("\n"),
              "  "
            );
          }
          b.trusted("");
        }
        if (truncated) {
          b.trusted(
            `(${totalMatches - maxResults} more result(s) omitted. Increase maxResults or narrow the search.)`
          );
        }
      });
    }
  );
}
