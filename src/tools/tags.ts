import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote } from "../lib/vault.js";
import { extractTags } from "../lib/markdown.js";
import { sanitizeError } from "../lib/errors.js";
import { mapConcurrent } from "../lib/concurrency.js";

const READ_CONCURRENCY = 16;
import type { TagInfo } from "../types.js";

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export function registerTagTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_tags",
    {
      title: "Get All Tags",
      description:
        "Enumerate every unique tag used across the vault along with the number of notes each tag appears in. Detects tags from both inline #hashtags and YAML frontmatter, normalizes them case-insensitively, and returns a sorted list plus the total unique tag count. Use to build a tag cloud, pick categories, audit taxonomy, or discover available tags before calling search_by_tag.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        sortBy: z
          .enum(["count", "name"])
          .optional()
          .default("count")
          .describe("Sort order: 'count' = by usage count descending (most-used first, default), 'name' = alphabetical by tag name"),
      },
    },
    async ({ sortBy }) => {
      try {
        const notes = await listNotes(vaultPath);
        const tagMap = new Map<string, { tag: string; files: Set<string> }>();

        const contents = await mapConcurrent(
          notes,
          READ_CONCURRENCY,
          (notePath) => readNote(vaultPath, notePath),
          (err, notePath) => {
            console.error(`Failed to read note for tag extraction: ${notePath}`, err);
          },
        );

        for (let i = 0; i < notes.length; i++) {
          const content = contents[i];
          if (content === undefined) continue;
          const notePath = notes[i];
          const tags = extractTags(content);
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

        if (sortBy === "name") {
          tagInfos.sort((a, b) => a.tag.localeCompare(b.tag));
        } else {
          tagInfos.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        }

        const lines: string[] = [];
        lines.push(`Total unique tags: ${tagInfos.length}`);
        lines.push("");

        for (const info of tagInfos) {
          lines.push(`#${info.tag} (${info.count} ${info.count === 1 ? "note" : "notes"})`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        console.error("Error in get_tags:", err);
        return errorResult(`Error listing tags: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "search_by_tag",
    {
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
          .describe("Tag to search for, with or without # prefix (e.g., 'project' or '#project'). Matches nested tags like 'project/alpha'."),
        includeContent: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, include the first 200 characters of each matching note as a preview (default: false)"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum number of matching notes to return (1-1000, default: 100)"),
      },
    },
    async ({ tag, includeContent, maxResults }) => {
      try {
        const searchTag = tag.replace(/^#/, "").toLowerCase();
        const notes = await listNotes(vaultPath);

        const contents = await mapConcurrent(
          notes,
          READ_CONCURRENCY,
          (notePath) => readNote(vaultPath, notePath),
          (err, notePath) => {
            console.error(`Failed to read note for tag search: ${notePath}`, err);
          },
        );

        const matchingNotes: { path: string; preview?: string }[] = [];
        for (let i = 0; i < notes.length; i++) {
          if (matchingNotes.length >= maxResults) break;
          const content = contents[i];
          if (content === undefined) continue;
          const notePath = notes[i];
          const tags = extractTags(content);
          const hasMatch = tags.some((t) => {
            const normalized = t.toLowerCase();
            return normalized === searchTag || normalized.startsWith(`${searchTag}/`);
          });
          if (hasMatch) {
            const entry: { path: string; preview?: string } = { path: notePath };
            if (includeContent) {
              entry.preview = content.slice(0, 200).trim();
            }
            matchingNotes.push(entry);
          }
        }

        if (matchingNotes.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No notes found with tag #${searchTag}` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`Found ${matchingNotes.length} ${matchingNotes.length === 1 ? "note" : "notes"} with tag #${searchTag}`);
        lines.push("");

        for (const note of matchingNotes) {
          lines.push(`- ${note.path}`);
          if (note.preview) {
            lines.push(`  ${note.preview}`);
            lines.push("");
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        console.error("Error in search_by_tag:", err);
        return errorResult(`Error searching by tag: ${sanitizeError(err)}`);
      }
    },
  );
}
