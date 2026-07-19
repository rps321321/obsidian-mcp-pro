import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prependToNote } from "../../lib/vault.js";
import { defineTool, text } from "../../lib/tool-seam.js";
import { displayWriteValue, ensureMdExtension } from "./shared.js";

export function registerPrependToNote(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "prepend_to_note",
      title: "Prepend to Note",
      description:
        "Insert content at the top of an existing note's body, immediately after the YAML frontmatter block if one is present (so metadata stays at the top of the file). Use for adding new items to the front of a running list, pinning context, or inserting TL;DR sections. Fails if the note does not exist.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Relative path from vault root to the target note (e.g., 'notes/log.md'). Extension optional."
          ),
        content: z
          .string()
          .max(1_000_000)
          .describe(
            "Markdown text to insert at the top of the body, after any frontmatter"
          ),
      },
    },
    async ({ path: notePath, content }) => {
      const resolvedPath = ensureMdExtension(notePath);
      await prependToNote(vaultPath, resolvedPath, content);
      return text(`Prepended content to '${displayWriteValue(resolvedPath)}'.`);
    }
  );
}
