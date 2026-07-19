import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, richText, error } from "../../lib/tool-seam.js";
import {
  buildLinkGraph,
  resolveGraphInputPath,
  findLineWithLink,
  escapeControlChars,
  resolveWikilinkWithIndex,
} from "./shared.js";

export function registerGetBacklinks(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_backlinks",
      title: "Get Backlinks",
      description:
        "List all notes that contain a wikilink pointing to the target note. Each result includes the source note path, line number, and the surrounding line text for context. Use to understand which notes reference a topic, or to assess the impact of renaming or deleting a note. Accepts paths with or without .md extension; falls back to basename matching if exact match fails.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Target note path relative to vault root (e.g., 'folder/note.md' or 'note'). Extension optional."
          ),
      },
    },
    async ({ path: targetPath }) => {
      const graph = await buildLinkGraph(vaultPath);

      const resolvedTarget = resolveGraphInputPath(graph, targetPath);

      if (!resolvedTarget) {
        return error(
          `No note found matching path: ${escapeControlChars(targetPath)}`
        );
      }

      const backlinkSources = graph.backlinks.get(resolvedTarget);
      if (!backlinkSources || backlinkSources.size === 0) {
        return richText("get_backlinks target path", (b) => {
          b.trusted("No backlinks found for:");
          b.untrusted(
            "get_backlinks target path",
            escapeControlChars(resolvedTarget),
            "  "
          );
        });
      }

      const results: { source: string; line: number; context: string }[] = [];

      for (const sourcePath of backlinkSources) {
        const lines = graph.noteLines.get(sourcePath) ?? [];
        // Find the line(s) that contain the link to the target
        const links = graph.rawLinks.get(sourcePath) ?? [];
        const relevantLinks = links.filter((l) => {
          const base = l.target.split("#")[0]!.trim();
          // Pass aliasMap so alias-only matches (e.g. `[[My Project]]`
          // pointing at a note whose frontmatter declares that alias)
          // resolve here exactly as they did during graph build. Without
          // it, the source slipped into the backlink set during build but
          // produced an empty line/context in this display pass.
          const resolved = resolveWikilinkWithIndex(
            base,
            sourcePath,
            graph.allNotes,
            graph.pathIndex,
            graph.aliasMap
          );
          return resolved === resolvedTarget;
        });

        if (relevantLinks.length > 0) {
          for (const link of relevantLinks) {
            const lineInfo = findLineWithLink(lines, link.target);
            results.push({
              source: sourcePath,
              line: lineInfo.line,
              context: lineInfo.content,
            });
          }
        } else {
          results.push({ source: sourcePath, line: 0, context: "" });
        }
      }

      // Deduplicate by source+line
      const seen = new Set<string>();
      const deduped = results.filter((r) => {
        const key = `${r.source}:${r.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return richText("get_backlinks paths and context", (b) => {
        b.trusted("Backlinks to:");
        b.untrusted(
          "get_backlinks target path",
          escapeControlChars(resolvedTarget),
          "  "
        );
        b.trusted(`Found: ${deduped.length} backlink(s)\n`);
        for (const r of deduped) {
          const lineStr = r.line > 0 ? `:${r.line}` : "";
          b.trusted("Source:");
          b.untrusted(
            "get_backlinks source path",
            `${escapeControlChars(r.source)}${lineStr}`,
            "  "
          );
          if (r.context) {
            // Intentional migration delta: the pre-seam renderer prefixed this
            // block with a decorative "→ " on the BEGIN line. The seam wraps
            // untrusted content as whole indented blocks, so the arrow is
            // dropped. The context is still BEGIN/END-wrapped with the same
            // "get_backlinks context" label and the block-level trust `_meta`
            // is unchanged — a purely visual delta, no trust impact.
            b.untrusted(
              "get_backlinks context",
              escapeControlChars(r.context),
              "  "
            );
          }
        }
      });
    }
  );
}
