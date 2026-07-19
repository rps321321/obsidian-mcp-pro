import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeNote, readNote } from "../../lib/vault.js";
import { getDailyNoteConfig } from "../../config.js";
import { sanitizeError } from "../../lib/errors.js";
import { defineTool, richText, error, asError } from "../../lib/tool-seam.js";
import { formatMomentDate, parseLocalDateOnly } from "../../lib/dates.js";
import { displayWriteValue, ensureMdExtension } from "./shared.js";

export function registerCreateDailyNote(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "create_daily_note",
      title: "Create Daily Note",
      description:
        "Create a daily note for today (or a specific date) in the vault's configured daily-note folder using its configured filename format. Optionally seed the note from a template file with Obsidian-style placeholder substitution: {{date}} and {{title}} → the formatted date; {{time}} → local HH:mm; {{date:FORMAT}} / {{time:FORMAT}} → custom moment-style format. Fails if the daily note already exists.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
          .optional()
          .describe(
            "Target date in YYYY-MM-DD format (defaults to today). Determines filename and {{date}} substitution."
          ),
        content: z
          .string()
          .max(1_000_000)
          .optional()
          .describe(
            "Initial markdown body for the daily note. Ignored if templatePath is provided."
          ),
        templatePath: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Relative path to a template note. Its content is copied into the new daily note with Obsidian-style placeholders substituted: {{date}}/{{title}} → formatted date, {{time}} → local HH:mm, and {{date:FORMAT}}/{{time:FORMAT}} → custom moment-style format."
          ),
      },
    },
    async ({ date, content, templatePath }) => {
      const config = await getDailyNoteConfig(vaultPath);
      const targetDate = date ? parseLocalDateOnly(date) : new Date();

      if (!targetDate) {
        return error("Error: Invalid date. Use YYYY-MM-DD.");
      }

      const dateStr = formatMomentDate(targetDate, config.format);
      const folder = config.folder ? `${config.folder}/` : "";
      const notePath = ensureMdExtension(`${folder}${dateStr}`);

      let finalContent = content ?? "";

      if (templatePath) {
        // Only allow markdown templates. Without this, `templatePath` could
        // point at any readable non-excluded vault file (e.g. a `.canvas`
        // or `.json`), turning the template slot into a generic file reader.
        const resolvedTemplate = ensureMdExtension(templatePath);
        try {
          const templateContent = await readNote(vaultPath, resolvedTemplate);
          // Match Obsidian's core Templates / Daily Notes substitution:
          //   {{date}}           → daily-notes formatted date
          //   {{date:FORMAT}}    → date formatted with caller-supplied moment-style format
          //   {{time}}           → local HH:mm
          //   {{time:FORMAT}}    → time/date formatted with caller-supplied format
          //   {{title}}          → file's title (== formatted date for daily notes)
          // The previous implementation only handled {{date}}, so any
          // real-world template referencing {{title}} or {{time}} leaked
          // the literal placeholder into the new daily note.
          finalContent = templateContent.replace(
            /\{\{(date|time|title)(?::([^}]*))?\}\}/g,
            (_match, token: string, fmt: string | undefined) => {
              if (token === "title") return dateStr;
              if (token === "date") {
                return fmt ? formatMomentDate(targetDate, fmt) : dateStr;
              }
              // token === "time"
              const now = new Date();
              return fmt
                ? formatMomentDate(now, fmt)
                : formatMomentDate(now, "HH:mm");
            }
          );
        } catch (err) {
          return error(`Error reading template: ${sanitizeError(err)}`);
        }
      }

      try {
        await writeNote(vaultPath, notePath, finalContent, { exclusive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return asError(
            richText("create_daily_note path", (b) => {
              b.trusted("Error: Daily note already exists.");
              b.untrusted(
                "create_daily_note path",
                displayWriteValue(notePath)
              );
            })
          );
        }
        throw err;
      }
      return richText("create_daily_note path", (b) => {
        b.trusted("Created daily note.");
        b.untrusted("create_daily_note path", displayWriteValue(notePath));
      });
    }
  );
}
