import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readNote, readNoteLineRange } from "../../lib/vault.js";
import { parseFrontmatter, extractTags } from "../../lib/markdown.js";
import {
  findSection,
  findBlockById,
  stripBlockId,
} from "../../lib/sections.js";
import { defineTool, error, untrustedText } from "../../lib/tool-seam.js";
import { displayReadValue, parseRequestedLineRange } from "./shared.js";

export function registerGetNoteTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_note",
      title: "Get Note",
      description:
        "Read a note in full or as a fragment. With no fragment options, returns parsed frontmatter (as a labeled header), a flat list of inline #tags, and the body. With `section`, returns just the body under that heading (path-form like 'Tasks/Today' is supported). With `block`, returns the paragraph or block tagged `^id`. With `lines`, returns the inclusive 1-indexed line range. Fragment modes skip the frontmatter/tag header and return raw text — use them to keep token usage tight on long notes.",
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
            "Relative path from vault root to the note (e.g., 'folder/note.md'). Extension required."
          ),
        section: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Heading path (e.g., 'Tasks' or 'Project A/Status'). Returns just that section's body."
          ),
        block: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Block id (without the leading `^`). Returns just the paragraph or block tagged with that id."
          ),
        lines: z
          .string()
          .regex(/^\d+(-\d+)?$/, "Must be N or N-M (1-indexed, inclusive)")
          .optional()
          .describe(
            "Line range, 1-indexed and inclusive (e.g., '10-25' or '42'). Returns just those lines."
          ),
      },
    },
    async ({ path: notePath, section, block, lines }) => {
      if (!section && !block && lines) {
        const parsedRange = parseRequestedLineRange(lines);
        if (!parsedRange) {
          return error(`Invalid lines format: "${displayReadValue(lines)}"`);
        }
        const range = await readNoteLineRange(
          vaultPath,
          notePath,
          parsedRange.start,
          parsedRange.end
        );
        if (range.pastEndLine) {
          return error(
            `Line ${range.pastEndLine.requested} is past end of file (${range.pastEndLine.total} lines)`
          );
        }
        return untrustedText("get_note fragment", range.text);
      }

      const content = await readNote(vaultPath, notePath);

      // Fragment modes are mutually exclusive — picking one skips the
      // frontmatter/tag header and returns raw text. Mode order: section
      // first (most user-facing), then block, then lines.
      if (section) {
        const headingPath = section
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean);
        const found = findSection(content, headingPath);
        if (!found) {
          return error(
            `Section not found: "${displayReadValue(section)}" in ${displayReadValue(notePath)}`
          );
        }
        return untrustedText(
          "get_note section",
          content.slice(found.start, found.end)
        );
      }

      if (block) {
        const found = findBlockById(content, block);
        if (!found) {
          return error(
            `Block not found: "^${displayReadValue(block)}" in ${displayReadValue(notePath)}`
          );
        }
        return untrustedText(
          "get_note block",
          stripBlockId(content.slice(found.start, found.end))
        );
      }

      if (lines) {
        const allLines = content.split("\n");
        const parsedRange = parseRequestedLineRange(lines);
        if (!parsedRange)
          return error(`Invalid lines format: "${displayReadValue(lines)}"`);
        if (parsedRange.start > allLines.length) {
          return error(
            `Line ${parsedRange.start} is past end of file (${allLines.length} lines)`
          );
        }
        const slice = allLines.slice(
          parsedRange.start - 1,
          Math.min(parsedRange.end, allLines.length)
        );
        return untrustedText("get_note fragment", slice.join("\n"));
      }

      const { data: frontmatterData, content: bodyContent } =
        parseFrontmatter(content);

      const header: string[] = [];
      if (Object.keys(frontmatterData).length > 0) {
        header.push("--- Frontmatter ---");
        for (const [key, value] of Object.entries(frontmatterData)) {
          header.push(
            `${displayReadValue(key)}: ${displayReadValue(JSON.stringify(value) ?? "")}`
          );
        }
        header.push("--- End Frontmatter ---");
        header.push("");
      }

      const tags = extractTags(content);
      if (tags.length > 0) {
        header.push(`Tags: ${tags.map(displayReadValue).join(", ")}`);
        header.push("");
      }

      const renderedNote =
        header.length > 0 ? header.join("\n") + bodyContent : content;
      return untrustedText("get_note body", renderedNote);
    }
  );
}
