import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateNote } from "../../lib/vault.js";
import { updateFrontmatter } from "../../lib/markdown.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { textResult, errorResult, displayWriteValue, ensureMdExtension, isPlainObject } from "./shared.js";

export function registerUpdateFrontmatter(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "update_frontmatter",
    {
      title: "Update Frontmatter",
      description:
        "Merge new key-value pairs into a note's YAML frontmatter, preserving any keys not mentioned and leaving the body content untouched. Keys in the payload overwrite existing values. Creates a frontmatter block if the note has none. Returns a count of properties written. Use to set status fields, tags arrays, or other metadata without rewriting the body.\n\nNote: The YAML block is regenerated on each update — comments, custom quoting, multi-line scalar style, blank lines, and key ordering inside the block are normalized. Key *presence and values* are preserved; formatting is not.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe("Relative path from vault root to the note (e.g., 'projects/alpha.md'). Extension optional."),
        properties: z
          .string()
          .max(100_000)
          .describe("JSON object string of frontmatter keys to set, e.g., '{\"status\":\"done\",\"priority\":1,\"tags\":[\"review\"]}'. Existing keys not in the payload are preserved."),
      },
    },
    async ({ path: notePath, properties }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);

        let parsed: unknown;
        try {
          parsed = JSON.parse(properties);
        } catch {
          return errorResult("Error: Invalid JSON in properties parameter.");
        }
        if (!isPlainObject(parsed)) {
          return errorResult(
            "Error: properties must be a JSON object (e.g. '{\"status\":\"done\"}'), not an array, string, number, boolean, or null.",
          );
        }
        const props = parsed;

        await updateNote(vaultPath, resolvedPath, (existing) =>
          updateFrontmatter(existing, props),
        );

        return textResult(`Updated frontmatter of '${displayWriteValue(resolvedPath)}' with ${Object.keys(props).length} properties.`);
      } catch (err) {
        log.error("update_frontmatter failed", { tool: "update_frontmatter", err: err as Error });
        return errorResult(`Error updating frontmatter: ${sanitizeError(err)}`);
      }
    },
  );
}
