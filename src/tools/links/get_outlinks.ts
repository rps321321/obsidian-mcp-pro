import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import {
  buildLinkGraph,
  resolveGraphInputPath,
  displayLinkValue,
  untrustedLinkBlock,
  pushUntrustedLinkTarget,
  textWithUntrustedMeta,
  errorResult,
} from "./shared.js";

export function registerGetOutlinks(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_outlinks",
    {
      title: "Get Outlinks",
      description:
        "List every outgoing wikilink from a note, partitioned into valid links (resolve to an existing note), broken links (target not found), and file embeds (![[...]]). Returns the raw link text and resolved paths. Use to audit a note's references, detect broken links, or follow downstream dependencies.",
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
          .describe("Source note path relative to vault root (e.g., 'folder/note.md'). Extension optional."),
      },
    },
    async ({ path: notePath }) => {
      try {
        // Route through the shared link graph so resolution uses the same
        // alias map the rest of the link tools rely on, and so the heavy
        // read/parse work is shared with backlinks/orphans/broken-links
        // calls. The graph already indexes raw links per source.
        const graph = await buildLinkGraph(vaultPath);

        const resolvedSource = resolveGraphInputPath(graph, notePath);
        if (!resolvedSource) {
          return errorResult(`No note found matching path: ${displayLinkValue(notePath)}`);
        }

        const results = graph.outlinkDetails.get(resolvedSource) ?? [];

        if (results.length === 0) {
          const text = [
            "No outgoing links found in:",
            untrustedLinkBlock("get_outlinks source path", displayLinkValue(resolvedSource), "  "),
          ].join("\n");
          return textWithUntrustedMeta(text, "get_outlinks source path");
        }

        const valid = results.filter((r) => r.isValid);
        const broken = results.filter((r) => !r.isValid);

        const lines: string[] = [
          "Outgoing links from:",
          untrustedLinkBlock("get_outlinks source path", displayLinkValue(resolvedSource), "  "),
          `Total: ${results.length} (${valid.length} valid, ${broken.length} broken)\n`,
        ];

        if (valid.length > 0) {
          lines.push("Valid links:");
          for (const r of valid) {
            lines.push("  Resolved path:");
            lines.push(untrustedLinkBlock(
              "get_outlinks resolved path",
              `${displayLinkValue(r.resolvedPath ?? "")}${r.isEmbed ? " (embed)" : ""}`,
              "    ",
            ));
            pushUntrustedLinkTarget(lines, "get_outlinks target", r.target, "    ");
          }
        }

        if (broken.length > 0) {
          lines.push("\nBroken links:");
          for (const r of broken) {
            lines.push(`  - unresolved${r.isEmbed ? " (embed)" : ""}`);
            pushUntrustedLinkTarget(lines, "get_outlinks broken target", r.target, "    ");
          }
        }

        return textWithUntrustedMeta(lines.join("\n"), "get_outlinks paths and targets");
      } catch (err) {
        log.error("get_outlinks failed", { tool: "get_outlinks", err: err as Error });
        return errorResult(`Error getting outlinks: ${sanitizeError(err)}`);
      }
    },
  );
}
