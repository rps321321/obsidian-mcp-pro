import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { indentBlock, formatUntrustedVaultContent } from "../../lib/tool-output.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import {
  buildLinkGraph,
  resolveGraphInputPath,
  findLineWithLink,
  displayLinkValue,
  untrustedLinkBlock,
  textWithUntrustedMeta,
  errorResult,
  resolveWikilinkWithIndex,
} from "./shared.js";

export function registerGetBacklinks(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_backlinks",
    {
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
          .describe("Target note path relative to vault root (e.g., 'folder/note.md' or 'note'). Extension optional."),
      },
    },
    async ({ path: targetPath }) => {
      try {
        const graph = await buildLinkGraph(vaultPath);

        const resolvedTarget = resolveGraphInputPath(graph, targetPath);

        if (!resolvedTarget) {
          return errorResult(`No note found matching path: ${displayLinkValue(targetPath)}`);
        }

        const backlinkSources = graph.backlinks.get(resolvedTarget);
        if (!backlinkSources || backlinkSources.size === 0) {
          const text = [
            "No backlinks found for:",
            untrustedLinkBlock("get_backlinks target path", displayLinkValue(resolvedTarget), "  "),
          ].join("\n");
          return textWithUntrustedMeta(text, "get_backlinks target path");
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
              graph.aliasMap,
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

        const outputLines = [
          "Backlinks to:",
          untrustedLinkBlock("get_backlinks target path", displayLinkValue(resolvedTarget), "  "),
          `Found: ${deduped.length} backlink(s)\n`,
        ];
        for (const r of deduped) {
          const lineStr = r.line > 0 ? `:${r.line}` : "";
          outputLines.push("Source:");
          outputLines.push(untrustedLinkBlock(
            "get_backlinks source path",
            `${displayLinkValue(r.source)}${lineStr}`,
            "  ",
          ));
          if (r.context) {
            outputLines.push(indentBlock(
              `→ ${formatUntrustedVaultContent(
                "get_backlinks context",
                displayLinkValue(r.context),
              )}`,
              "  ",
            ));
          }
        }
        const output = outputLines.join("\n");

        return {
          content: [{
            type: "text" as const,
            text: output,
            _meta: (await import("../../lib/tool-output.js")).untrustedVaultContentMeta("get_backlinks paths and context"),
          }],
        };
      } catch (err) {
        log.error("get_backlinks failed", { tool: "get_backlinks", err: err as Error });
        return errorResult(`Error finding backlinks: ${sanitizeError(err)}`);
      }
    },
  );
}
