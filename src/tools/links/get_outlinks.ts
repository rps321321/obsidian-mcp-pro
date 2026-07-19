import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, richText, error } from "../../lib/tool-seam.js";
import {
  buildLinkGraph,
  resolveGraphInputPath,
  escapeControlChars,
  untrustedLinkTarget,
} from "./shared.js";

export function registerGetOutlinks(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_outlinks",
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
          .describe(
            "Source note path relative to vault root (e.g., 'folder/note.md'). Extension optional."
          ),
      },
    },
    async ({ path: notePath }) => {
      // Route through the shared link graph so resolution uses the same
      // alias map the rest of the link tools rely on, and so the heavy
      // read/parse work is shared with backlinks/orphans/broken-links
      // calls. The graph already indexes raw links per source.
      const graph = await buildLinkGraph(vaultPath);

      const resolvedSource = resolveGraphInputPath(graph, notePath);
      if (!resolvedSource) {
        return error(
          `No note found matching path: ${escapeControlChars(notePath)}`
        );
      }

      const results = graph.outlinkDetails.get(resolvedSource) ?? [];

      if (results.length === 0) {
        return richText("get_outlinks source path", (b) => {
          b.trusted("No outgoing links found in:");
          b.untrusted(
            "get_outlinks source path",
            escapeControlChars(resolvedSource),
            "  "
          );
        });
      }

      const valid = results.filter((r) => r.isValid);
      const broken = results.filter((r) => !r.isValid);

      return richText("get_outlinks paths and targets", (b) => {
        b.trusted("Outgoing links from:");
        b.untrusted(
          "get_outlinks source path",
          escapeControlChars(resolvedSource),
          "  "
        );
        b.trusted(
          `Total: ${results.length} (${valid.length} valid, ${broken.length} broken)\n`
        );

        if (valid.length > 0) {
          b.trusted("Valid links:");
          for (const r of valid) {
            b.trusted("  Resolved path:");
            b.untrusted(
              "get_outlinks resolved path",
              `${escapeControlChars(r.resolvedPath ?? "")}${r.isEmbed ? " (embed)" : ""}`,
              "    "
            );
            untrustedLinkTarget(b, "get_outlinks target", r.target, "    ");
          }
        }

        if (broken.length > 0) {
          b.trusted("\nBroken links:");
          for (const r of broken) {
            b.trusted(`  - unresolved${r.isEmbed ? " (embed)" : ""}`);
            untrustedLinkTarget(
              b,
              "get_outlinks broken target",
              r.target,
              "    "
            );
          }
        }
      });
    }
  );
}
