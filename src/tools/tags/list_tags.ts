import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { sanitizeError } from "../../lib/errors.js";
import { formatUntrustedVaultContent, untrustedVaultContentMeta } from "../../lib/tool-output.js";
import { log } from "../../lib/logger.js";

import type { TagInfo } from "../../types.js";
import { errorResult, displayTagValue, getCachedTagIndex } from "./shared.js";

export function registerListTags(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_tags",
    {
      title: "List All Tags",
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

        // Cached batch read: re-uses content for files whose mtime hasn't
        // moved since the last vault-wide scan. Per-file failures are
        // logged and dropped so one unreadable note can't abort the index.
        const { contents, mtimes } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("list_tags: note read failed", { note, err });
        });

        const tagIndex = getCachedTagIndex(vaultPath, notes, contents, mtimes);
        const tagInfos: TagInfo[] = tagIndex.tagInfos.map((info) => ({
          tag: info.tag,
          count: info.count,
          files: [...info.files],
        }));

        if (sortBy === "name") {
          tagInfos.sort((a, b) => a.tag.localeCompare(b.tag));
        } else {
          tagInfos.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        }

        const lines: string[] = [];
        lines.push(`Total unique tags: ${tagInfos.length}`);
        lines.push("");

        const tagLines: string[] = [];
        for (const info of tagInfos) {
          tagLines.push(`#${displayTagValue(info.tag)} (${info.count} ${info.count === 1 ? "note" : "notes"})`);
        }
        if (tagLines.length > 0) {
          lines.push(formatUntrustedVaultContent("list_tags values", tagLines.join("\n")));
        }

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            ...(tagLines.length > 0 ? { _meta: untrustedVaultContentMeta("list_tags values") } : {}),
          }],
        };
      } catch (err) {
        log.error("list_tags failed", { tool: "list_tags", err: err as Error });
        return errorResult(`Error listing tags: ${sanitizeError(err)}`);
      }
    },
  );
}
