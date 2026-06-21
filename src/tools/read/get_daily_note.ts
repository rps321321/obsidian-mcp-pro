import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readNote } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { formatUntrustedVaultContent, untrustedVaultContentMeta } from "../../lib/tool-output.js";
import { formatLocalDateOnly, formatMomentDate, parseLocalDateOnly } from "../../lib/dates.js";
import { parseFrontmatter } from "../../lib/markdown.js";
import { getDailyNoteConfig } from "../../config.js";
import { displayReadValue, errorResult, untrustedReadBlock } from "./shared.js";

export function registerGetDailyNoteTool(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_daily_note",
    {
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
          .describe("Target date in YYYY-MM-DD format (defaults to today's local date)"),
      },
    },
    async ({ date }) => {
      try {
        const config = await getDailyNoteConfig(vaultPath);
        const targetDate = date ?? formatLocalDateOnly();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          return errorResult(`Invalid date format: "${displayReadValue(targetDate)}". Use YYYY-MM-DD.`);
        }
        const parsed = parseLocalDateOnly(targetDate);
        if (!parsed) {
          return errorResult(`Invalid date: "${displayReadValue(targetDate)}".`);
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
          const pathLabel = "get_daily_note expected path";
          return errorResult(
            `Daily note not found for ${displayReadValue(targetDate)}.\n${untrustedReadBlock(pathLabel, displayReadValue(notePath))}`,
            untrustedVaultContentMeta(pathLabel),
          );
        }

        const { data: dailyFrontmatter, content: dailyBody } = parseFrontmatter(content);
        const header: string[] = [
          `Daily Note: ${displayReadValue(targetDate)}`,
          `Path: ${displayReadValue(notePath)}`,
          "",
        ];

        if (Object.keys(dailyFrontmatter).length > 0) {
          header.push("--- Frontmatter ---");
          for (const [key, value] of Object.entries(dailyFrontmatter)) {
            header.push(`${displayReadValue(key)}: ${displayReadValue(JSON.stringify(value) ?? "")}`);
          }
          header.push("--- End Frontmatter ---");
          header.push("");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: formatUntrustedVaultContent("get_daily_note body", header.join("\n") + dailyBody),
              _meta: untrustedVaultContentMeta("get_daily_note body"),
            },
          ],
        };
      } catch (err) {
        log.error("get_daily_note failed", { tool: "get_daily_note", err: err as Error });
        return errorResult(`Error reading daily note: ${sanitizeError(err)}`);
      }
    },
  );
}
