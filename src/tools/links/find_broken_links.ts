import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { defineTool, text, richText } from "../../lib/tool-seam.js";
import type { BrokenLink } from "../../types.js";
import {
  buildLinkGraph,
  displayLinkValue,
  untrustedLinkTarget,
} from "./shared.js";

export function registerFindBrokenLinks(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "find_broken_links",
      title: "Find Broken Links",
      description:
        "Scan notes for wikilinks ([[target]]) whose target does not resolve to any existing note in the vault. Returns a per-source report grouping each note with its broken link text and line numbers, plus a total count. Use after renaming, moving, or deleting notes to catch dangling references. Resolution uses the whole vault even when scanning a single folder, so only truly unresolvable links are reported.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Restrict the scan to notes within this folder (resolution still uses the entire vault). Omit to scan every note."
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(200)
          .describe(
            "Maximum broken link entries to show (1-1000, default: 200). Grouped by source note. Remaining matches are summarized."
          ),
      },
    },
    async ({ folder, maxResults }) => {
      // Validate and capture folder scope before the whole-vault graph work
      // so a missing folder fails fast. Resolution still uses the full graph.
      const scanNotes = folder ? await listNotes(vaultPath, folder) : null;
      const graph = await buildLinkGraph(vaultPath);
      const notesToScan = scanNotes ?? graph.allNotes;

      const brokenBySource = new Map<string, BrokenLink[]>();

      for (const notePath of notesToScan) {
        const brokenLinks = graph.brokenLinks.get(notePath);
        if (!brokenLinks || brokenLinks.length === 0) continue;
        brokenBySource.set(notePath, brokenLinks);
      }

      if (brokenBySource.size === 0) {
        const scopeStr = folder
          ? ` in folder: ${displayLinkValue(folder)}`
          : "";
        return text(`No broken links found${scopeStr}`);
      }

      let totalBroken = 0;
      for (const brokenLinks of brokenBySource.values()) {
        totalBroken += brokenLinks.length;
      }

      const scopeStr = folder ? ` (folder: ${displayLinkValue(folder)})` : "";

      return richText("find_broken_links paths and targets", (b) => {
        b.trusted(`Broken links report${scopeStr}\n`);

        let shown = 0;
        for (const [sourcePath, brokenLinks] of brokenBySource) {
          if (shown >= maxResults) break;
          b.trusted("Source:");
          b.untrusted(
            "find_broken_links source path",
            displayLinkValue(sourcePath),
            "  "
          );
          for (const bl of brokenLinks) {
            if (shown >= maxResults) break;
            const lineStr = bl.line > 0 ? ` (line ${bl.line})` : "";
            b.trusted(`  - broken link${lineStr}`);
            untrustedLinkTarget(
              b,
              "find_broken_links target",
              bl.targetLink,
              "    "
            );
            shown++;
          }
          b.trusted("");
        }

        if (shown < totalBroken) {
          b.trusted(
            `... and ${totalBroken - shown} more broken link(s) not shown`
          );
        }
        b.trusted(
          `Total: ${totalBroken} broken link(s) across ${brokenBySource.size} file(s)`
        );
      });
    }
  );
}
