import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listNotes,
  getNoteStats,
  getVaultRootRealPath,
} from "../../lib/vault.js";
import { mapConcurrent } from "../../lib/concurrency.js";
import { defineTool, error, richText, text } from "../../lib/tool-seam.js";
import { escapeControlChars, parseSince } from "./shared.js";

/** Maximum number of concurrent file I/O operations for parallel vault scans. */
const MAX_CONCURRENT_OPS = 16;

export function registerGetRecentNotesTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_recent_notes",
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
          .max(50)
          .optional()
          .describe(
            "Filter to notes modified at or after this point. Accepts ISO 8601 (YYYY-MM-DD or full timestamp) or a relative span like '7d', '24h', '2w'."
          ),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Restrict to notes within this folder (relative to vault root). Omit to scan the entire vault."
          ),
      },
    },
    async ({ limit, since, folder }) => {
      const sinceMs = since ? parseSince(since) : null;
      if (since && sinceMs === null) {
        return error(
          `Invalid 'since' value: "${escapeControlChars(since)}". Use ISO date or relative span like '7d', '24h', '2w'.`
        );
      }
      const notes = await listNotes(vaultPath, folder);

      // Stat each note for mtime without reading bodies.
      type Row = { path: string; mtimeMs: number };
      const realVaultRoot = await getVaultRootRealPath(vaultPath);
      const stats = await mapConcurrent<string, Row | undefined>(
        notes,
        MAX_CONCURRENT_OPS,
        async (notePath) => {
          try {
            const st = await getNoteStats(vaultPath, notePath, {
              realVaultRoot,
            });
            return { path: notePath, mtimeMs: st.modified?.getTime() ?? 0 };
          } catch {
            return undefined;
          }
        }
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
        return text(
          since
            ? `No notes modified since ${escapeControlChars(since)}.`
            : "No notes in the vault."
        );
      }

      const rowLines: string[] = [];
      for (const r of top) {
        const iso = new Date(r.mtimeMs).toISOString();
        rowLines.push(`- ${escapeControlChars(r.path)}  (${iso})`);
      }
      return richText("get_recent_notes paths", (b) => {
        b.trusted(
          `${rows.length} note(s)${since ? ` modified since ${escapeControlChars(since)}` : ""}${rows.length > limit ? ` (showing first ${limit})` : ""}:`
        );
        b.trusted("");
        if (rowLines.length > 0) {
          b.untrusted("get_recent_notes paths", rowLines.join("\n"));
        }
      });
    }
  );
}
