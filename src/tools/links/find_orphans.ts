import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import type { OrphanNote } from "../../types.js";
import {
  buildLinkGraph,
  pushUntrustedLinkPathRows,
  textWithUntrustedMeta,
  errorResult,
} from "./shared.js";

export function registerFindOrphans(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "find_orphans",
    {
      title: "Find Orphan Notes",
      description:
        "Identify disconnected notes in the vault's link graph, classified into three groups: fully isolated (no links in or out), no-backlinks (nothing links to them), and no-outlinks (they link to nothing). Returns counts per category and an example list per category, capped by maxResults. Use to surface abandoned notes, missing hub pages, or candidates for archiving.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        includeOutlinksCheck: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), also report notes with no outgoing links; if false, only report fully-isolated notes and notes with no backlinks."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(200)
          .describe("Maximum total note paths to list across all categories (1-1000, default: 200). Full counts are always reported regardless."),
      },
    },
    async ({ includeOutlinksCheck, maxResults }) => {
      try {
        const graph = await buildLinkGraph(vaultPath);

        const noBacklinks: OrphanNote[] = [];
        const noOutlinks: OrphanNote[] = [];
        const fullyIsolated: OrphanNote[] = [];

        for (const notePath of graph.allNotes) {
          const hasBacklinks = (graph.backlinks.get(notePath)?.size ?? 0) > 0;
          const hasOutlinks = (graph.outlinks.get(notePath)?.size ?? 0) > 0;

          if (!hasBacklinks && !hasOutlinks) {
            fullyIsolated.push({ path: notePath, hasOutlinks: false, hasBacklinks: false });
          } else if (!hasBacklinks) {
            noBacklinks.push({ path: notePath, hasOutlinks, hasBacklinks: false });
          } else if (!hasOutlinks && includeOutlinksCheck) {
            noOutlinks.push({ path: notePath, hasOutlinks: false, hasBacklinks });
          }
        }

        // Apply maxResults cap across all categories
        let remaining = maxResults;

        const cappedIsolated = fullyIsolated.slice(0, remaining);
        remaining -= cappedIsolated.length;
        const cappedNoBacklinks = noBacklinks.slice(0, Math.max(0, remaining));
        remaining -= cappedNoBacklinks.length;
        const cappedNoOutlinks = includeOutlinksCheck ? noOutlinks.slice(0, Math.max(0, remaining)) : [];

        const lines: string[] = [
          `Orphan analysis for vault (${graph.allNotes.length} notes total)\n`,
        ];

        let hasDisplayedPathRows = false;

        lines.push(`Fully isolated (no links in or out): ${fullyIsolated.length}`);
        hasDisplayedPathRows = pushUntrustedLinkPathRows(
          lines,
          "find_orphans fully isolated paths",
          cappedIsolated.map((note) => `- ${note.path}`),
          "  ",
        ) || hasDisplayedPathRows;
        if (cappedIsolated.length < fullyIsolated.length) {
          lines.push(`  ... and ${fullyIsolated.length - cappedIsolated.length} more`);
        }

        lines.push(`\nNo backlinks (not linked by any note): ${noBacklinks.length}`);
        hasDisplayedPathRows = pushUntrustedLinkPathRows(
          lines,
          "find_orphans no-backlink paths",
          cappedNoBacklinks.map((note) => `- ${note.path}`),
          "  ",
        ) || hasDisplayedPathRows;
        if (cappedNoBacklinks.length < noBacklinks.length) {
          lines.push(`  ... and ${noBacklinks.length - cappedNoBacklinks.length} more`);
        }

        if (includeOutlinksCheck) {
          lines.push(`\nNo outlinks (links to no other notes): ${noOutlinks.length}`);
          hasDisplayedPathRows = pushUntrustedLinkPathRows(
            lines,
            "find_orphans no-outlink paths",
            cappedNoOutlinks.map((note) => `- ${note.path}`),
            "  ",
          ) || hasDisplayedPathRows;
          if (cappedNoOutlinks.length < noOutlinks.length) {
            lines.push(`  ... and ${noOutlinks.length - cappedNoOutlinks.length} more`);
          }
        }

        const totalOrphans = fullyIsolated.length + noBacklinks.length + (includeOutlinksCheck ? noOutlinks.length : 0);
        lines.push(`\nTotal orphan entries: ${totalOrphans}`);

        return hasDisplayedPathRows
          ? textWithUntrustedMeta(lines.join("\n"), "find_orphans paths")
          : { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        log.error("find_orphans failed", { tool: "find_orphans", err: err as Error });
        return errorResult(`Error finding orphans: ${sanitizeError(err)}`);
      }
    },
  );
}
