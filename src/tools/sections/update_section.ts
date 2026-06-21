import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  updateNote,
} from "../../lib/vault.js";
import {
  findSection,
  replaceSectionBody,
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

export function registerUpdateSectionTool(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "update_section",
    {
      title: "Update Section",
      description:
        "Replace the body of a specific section (everything between a heading and the next heading at any level). The heading line itself is preserved. `section` is a heading path: `'Tasks'`, `'Project A/Status'`, etc. - case-insensitive and whitespace-tolerant. Use this instead of rewriting the whole file when you only need to update one section.",
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
          .describe("Vault-relative path to the note (e.g., 'folder/note.md'). Extension required."),
        section: z
          .string()
          .min(1)
          .describe("Heading path identifying the section to replace (e.g., 'Tasks' or 'Daily/Today')."),
        newBody: z
          .string()
          .max(SECTION_EDIT_PAYLOAD_MAX_CHARS)
          .describe("Replacement body content. The heading line itself is kept intact."),
      },
    },
    async ({ path: notePath, section, newBody }) => {
      try {
        const headingPath = splitHeadingPath(section);
        if (headingPath.length === 0) return errorResult("section must not be empty");

        let resolvedHeading = "";
        let bodyBytes = 0;
        await assertReadableEditTarget(vaultPath, notePath);
        await updateNote(vaultPath, notePath, (existing) => {
          const found = findSection(existing, headingPath);
          if (!found) {
            throw new Error(`Section not found: "${section}"`);
          }
          resolvedHeading = found.heading.text;
          const updated = replaceSectionBody(existing, found, newBody);
          bodyBytes = Buffer.byteLength(newBody, "utf-8");
          return updated;
        });
        invalidateSectionListCache(vaultPath, notePath);
        return textResultWithMeta(
          [
            `Updated section in ${displaySectionValue(notePath)} (${bodyBytes} bytes of new body)`,
            renderResolvedHeading("update_section resolved heading", resolvedHeading),
          ].join("\n"),
          "update_section resolved heading",
        );
      } catch (err) {
        log.error("update_section failed", { tool: "update_section", err: err as Error });
        return errorResult(`Error updating section: ${sanitizeError(err)}`);
      }
    },
  );
}
