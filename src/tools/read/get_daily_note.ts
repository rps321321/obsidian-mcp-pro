import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readNote } from "../../lib/vault.js";
import {
  formatLocalDateOnly,
  formatMomentDate,
  parseLocalDateOnly,
} from "../../lib/dates.js";
import { parseFrontmatter } from "../../lib/markdown.js";
import { getDailyNoteConfig } from "../../config.js";
import {
  asError,
  defineTool,
  error,
  richText,
  untrustedText,
} from "../../lib/tool-seam.js";
import { escapeControlChars } from "./shared.js";

export function registerGetDailyNoteTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_daily_note",
      title: "Get Daily Note",
      description:
        "Read the daily note for today or for a specific date, resolved via the vault's configured daily-note folder and filename format. Returns the note path, parsed frontmatter (as a labeled header block), and body. Errors if no daily note exists for that date — use create_daily_note to create one.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
          .optional()
          .describe(
            "Target date in YYYY-MM-DD format (defaults to today's local date)"
          ),
      },
    },
    async ({ date }) => {
      const config = await getDailyNoteConfig(vaultPath);
      const targetDate = date ?? formatLocalDateOnly();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return error(
          `Invalid date format: "${escapeControlChars(targetDate)}". Use YYYY-MM-DD.`
        );
      }
      const parsed = parseLocalDateOnly(targetDate);
      if (!parsed) {
        return error(`Invalid date: "${escapeControlChars(targetDate)}".`);
      }

      // Build the filename using moment-style tokens (YYYY, MMM, ddd, etc).
      let filename = formatMomentDate(parsed, config.format);
      if (!filename.endsWith(".md")) {
        filename += ".md";
      }

      const notePath = config.folder
        ? `${config.folder}/${filename}`
        : filename;

      let content: string;
      try {
        content = await readNote(vaultPath, notePath);
      } catch {
        // A read failure here means the daily note does not exist yet — a
        // domain outcome, not an unexpected error. Surface the expected path
        // as untrusted vault content so the client can offer to create it.
        const pathLabel = "get_daily_note expected path";
        return asError(
          richText(pathLabel, (b) => {
            b.trusted(
              `Daily note not found for ${escapeControlChars(targetDate)}.`
            );
            b.untrusted(pathLabel, escapeControlChars(notePath));
          })
        );
      }

      const { data: dailyFrontmatter, content: dailyBody } =
        parseFrontmatter(content);
      const header: string[] = [
        `Daily Note: ${escapeControlChars(targetDate)}`,
        `Path: ${escapeControlChars(notePath)}`,
        "",
      ];

      if (Object.keys(dailyFrontmatter).length > 0) {
        header.push("--- Frontmatter ---");
        for (const [key, value] of Object.entries(dailyFrontmatter)) {
          header.push(
            `${escapeControlChars(key)}: ${escapeControlChars(JSON.stringify(value) ?? "")}`
          );
        }
        header.push("--- End Frontmatter ---");
        header.push("");
      }

      return untrustedText(
        "get_daily_note body",
        header.join("\n") + dailyBody
      );
    }
  );
}
