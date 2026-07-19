import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { log } from "../../lib/logger.js";
import { defineTool, richText, text } from "../../lib/tool-seam.js";

import { displayTagValue, getCachedTagIndex } from "./shared.js";

export function registerSearchByTag(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "search_by_tag",
      title: "Search by Tag",
      description:
        "Find all notes tagged with a specific tag, including nested sub-tags (searching 'project' matches both #project and #project/alpha). Detects tags from both inline #hashtags and YAML frontmatter. Returns matching note paths with optional content previews. Use to collect notes belonging to a topic, area, or workflow stage.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        tag: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Tag to search for, with or without # prefix (e.g., 'project' or '#project'). Matches nested tags like 'project/alpha'."
          ),
        includeContent: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, include the first 200 characters of each matching note as a preview (default: false)"
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe(
            "Maximum number of matching notes to return (1-1000, default: 100)"
          ),
      },
    },
    async ({ tag, includeContent, maxResults }) => {
      const searchTag = tag.replace(/^#/, "").toLowerCase();
      const notes = await listNotes(vaultPath);

      const { contents, mtimes } = await readAllCached(
        vaultPath,
        notes,
        (note, err) => {
          log.warn("search_by_tag: note read failed", { note, err });
        }
      );

      const tagIndex = getCachedTagIndex(vaultPath, notes, contents, mtimes);
      const matchingPathSet = new Set<string>();
      for (const [normalizedTag, files] of tagIndex.tagToFiles) {
        if (
          normalizedTag === searchTag ||
          normalizedTag.startsWith(`${searchTag}/`)
        ) {
          for (const file of files) matchingPathSet.add(file);
        }
      }
      const matchingPaths = [...matchingPathSet]
        .sort(
          (a, b) =>
            (tagIndex.noteOrder.get(a) ?? 0) - (tagIndex.noteOrder.get(b) ?? 0)
        )
        .slice(0, maxResults);
      const matchingNotes: { path: string; preview?: string }[] =
        matchingPaths.map((notePath) => {
          const entry: { path: string; preview?: string } = { path: notePath };
          if (includeContent) {
            const content = contents.get(notePath)!;
            const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");
            entry.preview = stripped.slice(0, 200).trim();
          }
          return entry;
        });

      if (matchingNotes.length === 0) {
        return text(`No notes found with tag #${displayTagValue(searchTag)}`);
      }

      return richText(
        includeContent
          ? "search_by_tag paths and previews"
          : "search_by_tag paths",
        (b) => {
          b.trusted(
            `Found ${matchingNotes.length} ${matchingNotes.length === 1 ? "note" : "notes"} with tag #${displayTagValue(searchTag)}`
          );
          b.trusted("");

          for (const note of matchingNotes) {
            b.trusted("Path:");
            b.untrusted(
              "search_by_tag result path",
              displayTagValue(note.path),
              "  "
            );
            if (note.preview) {
              b.trusted("  Preview:");
              b.untrusted(
                "search_by_tag preview",
                displayTagValue(note.preview),
                "    "
              );
              b.trusted("");
            }
          }
        }
      );
    }
  );
}
