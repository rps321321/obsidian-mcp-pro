import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateNote } from "../../lib/vault.js";
import { findBlockById } from "../../lib/sections.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { defineTool, text, error } from "../../lib/tool-seam.js";
import {
  SECTION_EDIT_PAYLOAD_MAX_CHARS,
  displaySectionValue,
  assertReadableEditTarget,
  invalidateSectionListCache,
} from "./shared.js";

export function registerEditBlockTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "edit_block",
      title: "Edit Block",
      description:
        "Replace the content of a block tagged with `^id`. The trailing `^id` anchor is preserved on the last line of the new content so existing transclusions (`![[note#^id]]`) keep working. Use to update a single paragraph or list item that other notes reference.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
        block: z
          .string()
          .min(1)
          .transform((s) => s.replace(/^\^+/, ""))
          .refine((s) => s.length > 0, {
            message: "block id must not be empty after stripping leading '^'",
          })
          .describe(
            "Block id with or without the leading `^` (e.g. `myid` or `^myid`)."
          ),
        newContent: z
          .string()
          .max(SECTION_EDIT_PAYLOAD_MAX_CHARS)
          .describe(
            "Replacement content. The `^id` anchor is appended automatically."
          ),
      },
    },
    async ({ path: notePath, block, newContent }) => {
      try {
        await assertReadableEditTarget(vaultPath, notePath);
        await updateNote(vaultPath, notePath, (existing) => {
          const found = findBlockById(existing, block);
          if (!found) throw new Error(`Block not found: "^${block}"`);
          const before = existing.slice(0, found.start);
          const after = existing.slice(found.end);
          const body = newContent.replace(/\n+$/, "");
          const isMultiline = body.includes("\n");
          const replacement = isMultiline
            ? `${body}\n^${block}\n`
            : `${body} ^${block}\n`;
          return before + replacement + after;
        });
        invalidateSectionListCache(vaultPath, notePath);
        return text(
          `Updated block ^${displaySectionValue(block)} in ${displaySectionValue(notePath)}`
        );
      } catch (err) {
        log.error("edit_block failed", {
          tool: "edit_block",
          err: err as Error,
        });
        return error(`Error editing block: ${sanitizeError(err)}`);
      }
    }
  );
}
