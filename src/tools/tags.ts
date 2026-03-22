import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, readNote } from "../lib/vault.js";
import { extractTags } from "../lib/markdown.js";
import type { TagInfo } from "../types.js";

export function registerTagTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_tags",
    {
      description: "List all tags used in the vault with their usage counts",
      inputSchema: {
        sortBy: z
          .enum(["count", "name"])
          .optional()
          .default("count")
          .describe("Sort tags by usage count (descending) or name (alphabetical)"),
      },
    },
    async ({ sortBy }) => {
      try {
        const notes = await listNotes(vaultPath);
        const tagMap = new Map<string, TagInfo>();

        for (const notePath of notes) {
          let content: string;
          try {
            content = await readNote(vaultPath, notePath);
          } catch (err) {
            console.error(`Failed to read note for tag extraction: ${notePath}`, err);
            continue;
          }

          const tags = extractTags(content);
          for (const tag of tags) {
            const normalizedTag = tag.toLowerCase();
            const existing = tagMap.get(normalizedTag);
            if (existing) {
              existing.count++;
              if (!existing.files.includes(notePath)) {
                existing.files.push(notePath);
              }
            } else {
              tagMap.set(normalizedTag, {
                tag: normalizedTag,
                count: 1,
                files: [notePath],
              });
            }
          }
        }

        const tagInfos = Array.from(tagMap.values());

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
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing tags: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "search_by_tag",
    {
      description: "Find all notes that contain a specific tag",
      inputSchema: {
        tag: z.string().describe("Tag to search for (with or without # prefix)"),
        includeContent: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, include first 200 characters of note content as a preview"),
      },
    },
    async ({ tag, includeContent }) => {
      try {
        const searchTag = tag.replace(/^#/, "").toLowerCase();
        const notes = await listNotes(vaultPath);
        const matchingNotes: { path: string; preview?: string }[] = [];

        for (const notePath of notes) {
          let content: string;
          try {
            content = await readNote(vaultPath, notePath);
          } catch (err) {
            console.error(`Failed to read note for tag search: ${notePath}`, err);
            continue;
          }

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
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching by tag: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
