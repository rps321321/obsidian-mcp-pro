import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  updateNote,
} from "../../lib/vault.js";
import {
  findSection,
  insertAfterHeading,
} from "../../lib/sections.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import {
  SECTION_EDIT_PAYLOAD_MAX_CHARS,
  textResultWithMeta,
  errorResult,
  displaySectionValue,
  renderResolvedHeading,
  assertReadableEditTarget,
  invalidateSectionListCache,
  splitHeadingPath,
} from "./shared.js";

export function registerInsertAtSectionTool(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "insert_at_section",
    {
      title: "Insert at Section",
      description:
        "Insert content into a specific section without replacing it. `position` controls where: 'before' inserts above the heading, 'after-heading' inserts immediately under the heading line (at the top of the section body), 'append' inserts at the end of the section's body just before the next heading. Use to add a new bullet or paragraph without rewriting the section.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
        section: z.string().min(1).describe("Heading path identifying the section."),
        content: z
          .string()
          .max(SECTION_EDIT_PAYLOAD_MAX_CHARS)
          .describe("Content to insert. A trailing newline is normalized."),
        position: z
          .enum(["before", "after-heading", "append"])
          .default("append")
          .describe("Insert before the heading line, immediately after the heading, or at the end of the section body."),
      },
    },
    async ({ path: notePath, section, content, position }) => {
      try {
        const headingPath = splitHeadingPath(section);
        if (headingPath.length === 0) return errorResult("section must not be empty");

        let resolvedHeading = "";
        await assertReadableEditTarget(vaultPath, notePath);
        await updateNote(vaultPath, notePath, (existing) => {
          const found = findSection(existing, headingPath);
          if (!found) {
            throw new Error(`Section not found: "${section}"`);
          }
          resolvedHeading = found.heading.text;
          if (position === "after-heading") {
            return insertAfterHeading(existing, found, content);
          }
          if (position === "before") {
            const before = existing.slice(0, found.start);
            const after = existing.slice(found.start);
            const trailing = content.endsWith("\n") ? "" : "\n";
            return before + content + trailing + after;
          }
          const before = existing.slice(0, found.end);
          const after = existing.slice(found.end);
          let payload = content;
          if (!before.endsWith("\n")) payload = "\n" + payload;
          if (!payload.endsWith("\n")) payload += "\n";
          return before + payload + after;
        });
        invalidateSectionListCache(vaultPath, notePath);
        return textResultWithMeta(
          [
            `Inserted ${Buffer.byteLength(content, "utf-8")} bytes (${position}) in ${displaySectionValue(notePath)}`,
            renderResolvedHeading("insert_at_section resolved heading", resolvedHeading),
          ].join("\n"),
          "insert_at_section resolved heading",
        );
      } catch (err) {
        log.error("insert_at_section failed", { tool: "insert_at_section", err: err as Error });
        return errorResult(`Error inserting at section: ${sanitizeError(err)}`);
      }
    },
  );
}
