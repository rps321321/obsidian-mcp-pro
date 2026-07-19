import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendToNote } from "../../lib/vault.js";
import { defineTool, text } from "../../lib/tool-seam.js";
import { displayWriteValue, ensureMdExtension } from "./shared.js";

export function registerAppendToNote(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "append_to_note",
      title: "Append to Note",
      description:
        "Append text to the end of an existing note without altering prior content. By default, inserts a leading newline if the file does not already end in one, so appended content starts on its own line. Use for log entries, running lists, or adding new sections. Fails if the note does not exist — use create_note to make a new note first.",
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
            "Relative path from vault root to the target note (e.g., 'journal/2026-04-15.md'). Extension optional."
          ),
        content: z
          .string()
          .max(1_000_000)
          .describe(
            "Markdown text to append to the end of the note. A leading newline is auto-inserted when the file does not already end in one."
          ),
      },
    },
    async ({ path: notePath, content }) => {
      const resolvedPath = ensureMdExtension(notePath);
      await appendToNote(vaultPath, resolvedPath, content);
      return text(`Appended content to '${displayWriteValue(resolvedPath)}'.`);
    }
  );
}
