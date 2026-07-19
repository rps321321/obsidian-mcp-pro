import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeNote } from "../../lib/vault.js";
import { defineTool, text, error } from "../../lib/tool-seam.js";
import {
  escapeControlChars,
  ensureMdExtension,
  buildFrontmatterContent,
  isPlainObject,
} from "./shared.js";

export function registerCreateNote(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "create_note",
      title: "Create Note",
      description:
        "Create a new markdown note at the given path with body content and optional YAML frontmatter. Fails (does not overwrite) if a note already exists at that path — use append_to_note, prepend_to_note, or update_frontmatter for existing notes. Missing directories are created automatically, and a .md extension is appended if omitted.",
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
            "Relative path from vault root, e.g., 'folder/note.md' or 'note' (.md added automatically)"
          ),
        content: z
          .string()
          .max(1_000_000)
          .describe(
            "Markdown body content for the note (rendered below the frontmatter block if any)"
          ),
        frontmatter: z
          .string()
          .max(100_000)
          .optional()
          .describe(
            'JSON object string of frontmatter key-value pairs (e.g., \'{"status":"draft","tags":["idea"]}\'). Rendered as YAML at the top of the note.'
          ),
      },
    },
    async ({ path: notePath, content, frontmatter }) => {
      const resolvedPath = ensureMdExtension(notePath);
      const displayedPath = escapeControlChars(resolvedPath);

      let finalContent: string;

      if (frontmatter) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frontmatter);
        } catch {
          return error("Error: Invalid JSON in frontmatter parameter.");
        }
        if (!isPlainObject(parsed)) {
          return error(
            'Error: frontmatter must be a JSON object (e.g. \'{"status":"draft"}\'), not an array, string, number, boolean, or null.'
          );
        }
        finalContent = buildFrontmatterContent(parsed, content);
      } else {
        finalContent = content;
      }

      try {
        await writeNote(vaultPath, resolvedPath, finalContent, {
          exclusive: true,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return error(
            `Error: Note already exists at '${displayedPath}'. Use append or update tools instead.`
          );
        }
        throw err;
      }
      return text(`Created note at '${displayedPath}'.`);
    }
  );
}
