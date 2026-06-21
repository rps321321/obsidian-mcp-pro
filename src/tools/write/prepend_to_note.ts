import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prependToNote } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { textResult, errorResult, displayWriteValue, ensureMdExtension } from "./shared.js";

export function registerPrependToNote(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "prepend_to_note",
    {
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
          .describe("Relative path from vault root to the target note (e.g., 'notes/log.md'). Extension optional."),
        content: z
          .string()
          .max(1_000_000)
          .describe("Markdown text to insert at the top of the body, after any frontmatter"),
      },
    },
    async ({ path: notePath, content }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);
        await prependToNote(vaultPath, resolvedPath, content);
        return textResult(`Prepended content to '${displayWriteValue(resolvedPath)}'.`);
      } catch (err) {
        log.error("prepend_to_note failed", { tool: "prepend_to_note", err: err as Error });
        return errorResult(`Error prepending to note: ${sanitizeError(err)}`);
      }
    },
  );
}
