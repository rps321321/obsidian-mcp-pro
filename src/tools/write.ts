import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  writeNote,
  appendToNote,
  prependToNote,
  deleteNote,
  moveNote,
  readNote,
  updateNote,
} from "../lib/vault.js";
import { updateFrontmatter } from "../lib/markdown.js";
import { getDailyNoteConfig } from "../config.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import { formatFailedPath } from "../lib/tool-output.js";
import { formatMomentDate, parseLocalDateOnly } from "../lib/dates.js";
import { elicitTextConfirmation } from "../lib/confirmation.js";
import { log } from "../lib/logger.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

const displayWriteValue = escapeControlChars;

function ensureMdExtension(filePath: string): string {
  return /\.md$/i.test(filePath) ? filePath : `${filePath}.md`;
}

function buildFrontmatterContent(frontmatterObj: Record<string, unknown>, body: string): string {
  return updateFrontmatter(body, frontmatterObj);
}

// Frontmatter must be a YAML mapping at the root. `JSON.parse` happily returns
// strings, numbers, booleans, null, and arrays as well — feeding any of those
// to `matter.stringify` produces malformed (or surprising) YAML. Reject early
// with a clear message instead of writing a broken file to disk.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerWriteTools(server: McpServer, vaultPath: string): void {
  // 1. create_note
  server.registerTool(
    "create_note",
    {
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
          .describe("Relative path from vault root, e.g., 'folder/note.md' or 'note' (.md added automatically)"),
        content: z
          .string()
          .max(1_000_000)
          .describe("Markdown body content for the note (rendered below the frontmatter block if any)"),
        frontmatter: z
          .string()
          .max(100_000)
          .optional()
          .describe("JSON object string of frontmatter key-value pairs (e.g., '{\"status\":\"draft\",\"tags\":[\"idea\"]}'). Rendered as YAML at the top of the note."),
      },
    },
    async ({ path: notePath, content, frontmatter }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);
        const displayedPath = displayWriteValue(resolvedPath);

        let finalContent: string;

        if (frontmatter) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(frontmatter);
          } catch {
            return errorResult("Error: Invalid JSON in frontmatter parameter.");
          }
          if (!isPlainObject(parsed)) {
            return errorResult(
              "Error: frontmatter must be a JSON object (e.g. '{\"status\":\"draft\"}'), not an array, string, number, boolean, or null.",
            );
          }
          finalContent = buildFrontmatterContent(parsed, content);
        } else {
          finalContent = content;
        }

        try {
          await writeNote(vaultPath, resolvedPath, finalContent, { exclusive: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            return errorResult(`Error: Note already exists at '${displayedPath}'. Use append or update tools instead.`);
          }
          throw err;
        }
        return textResult(`Created note at '${displayedPath}'.`);
      } catch (err) {
        log.error("create_note failed", { tool: "create_note", err: err as Error });
        return errorResult(`Error creating note: ${sanitizeError(err)}`);
      }
    },
  );

  // 2. append_to_note
  server.registerTool(
    "append_to_note",
    {
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
          .describe("Relative path from vault root to the target note (e.g., 'journal/2026-04-15.md'). Extension optional."),
        content: z
          .string()
          .max(1_000_000)
          .describe("Markdown text to append to the end of the note. A leading newline is auto-inserted when the file does not already end in one."),
      },
    },
    async ({ path: notePath, content }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);
        await appendToNote(vaultPath, resolvedPath, content);
        return textResult(`Appended content to '${displayWriteValue(resolvedPath)}'.`);
      } catch (err) {
        log.error("append_to_note failed", { tool: "append_to_note", err: err as Error });
        return errorResult(`Error appending to note: ${sanitizeError(err)}`);
      }
    },
  );

  // 3. prepend_to_note
  server.registerTool(
    "prepend_to_note",
    {
      title: "Prepend to Note",
      description:
        "Insert content at the top of an existing note's body, immediately after the YAML frontmatter block if one is present (so metadata stays at the top of the file). Use for adding new items to the front of a running list, pinning context, or inserting TL;DR sections. Fails if the note does not exist.",
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
          .describe("Relative path from vault root to the target note (e.g., 'notes/log.md'). Extension optional."),
        content: z
          .string()
          .max(1_000_000)
          .describe("Markdown text to insert at the top of the body, after any frontmatter"),
      },
    },
    async ({ path: notePath, content }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);
        await prependToNote(vaultPath, resolvedPath, content);
        return textResult(`Prepended content to '${displayWriteValue(resolvedPath)}'.`);
      } catch (err) {
        log.error("prepend_to_note failed", { tool: "prepend_to_note", err: err as Error });
        return errorResult(`Error prepending to note: ${sanitizeError(err)}`);
      }
    },
  );

  // 4. update_frontmatter
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

  // 5. create_daily_note
  server.registerTool(
    "create_daily_note",
    {
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
          .describe("Target date in YYYY-MM-DD format (defaults to today). Determines filename and {{date}} substitution."),
        content: z
          .string()
          .max(1_000_000)
          .optional()
          .describe("Initial markdown body for the daily note. Ignored if templatePath is provided."),
        templatePath: z
          .string()
          .max(500)
          .optional()
          .describe("Relative path to a template note. Its content is copied into the new daily note with Obsidian-style placeholders substituted: {{date}}/{{title}} → formatted date, {{time}} → local HH:mm, and {{date:FORMAT}}/{{time:FORMAT}} → custom moment-style format."),
      },
    },
    async ({ date, content, templatePath }) => {
      try {
        const config = await getDailyNoteConfig(vaultPath);
        const targetDate = date ? parseLocalDateOnly(date) : new Date();

        if (!targetDate) {
          return errorResult("Error: Invalid date. Use YYYY-MM-DD.");
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
                return fmt ? formatMomentDate(now, fmt) : formatMomentDate(now, "HH:mm");
              },
            );
          } catch (err) {
            return errorResult(`Error reading template: ${sanitizeError(err)}`);
          }
        }

        try {
          await writeNote(vaultPath, notePath, finalContent, { exclusive: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            return errorResult(`Error: Daily note already exists at '${displayWriteValue(notePath)}'.`);
          }
          throw err;
        }
        return textResult(`Created daily note at '${displayWriteValue(notePath)}'.`);
      } catch (err) {
        log.error("create_daily_note failed", { tool: "create_daily_note", err: err as Error });
        return errorResult(`Error creating daily note: ${sanitizeError(err)}`);
      }
    },
  );

  // 6. move_note
  server.registerTool(
    "move_note",
    {
      title: "Move/Rename Note",
      description:
        "Move or rename a note within the vault, preserving its full content. Parent folders at the destination are created as needed. By default, wikilinks and file references are updated, matching Obsidian's \"Automatically update internal links\" behavior. Pass `updateLinks: false` to skip the rewrite scan (faster on large vaults; pair with `find_broken_links` if you need to audit afterward). A .md extension is added automatically if omitted from either path.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        oldPath: z
          .string()
          .min(1)
          .max(500)
          .describe("Current relative path of the note from vault root (e.g., 'inbox/idea.md')"),
        newPath: z
          .string()
          .min(1)
          .max(500)
          .describe("Destination relative path from vault root (e.g., 'projects/idea.md'). Creates intermediate folders as needed."),
        updateLinks: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), update every wikilink, markdown link, and canvas node reference across the vault to point at the new path. Set false to skip the rewrite pass."),
      },
    },
    async ({ oldPath, newPath, updateLinks }) => {
      try {
        const resolvedOld = ensureMdExtension(oldPath);
        const resolvedNew = ensureMdExtension(newPath);
        if (updateLinks !== false) {
          const confirmation = await elicitTextConfirmation(server, {
            tool: "move_note",
            message:
              `Move "${displayWriteValue(resolvedOld)}" to "${displayWriteValue(resolvedNew)}" and update references across the vault? ` +
              "This can rewrite many notes. Type the destination path to confirm.",
            fieldName: "confirmPath",
            fieldDescription: "Re-type the destination path to confirm vault-wide reference rewriting.",
            expectedValue: resolvedNew,
          });
          if (confirmation.status === "cancelled") {
            return textResult(`Move of "${displayWriteValue(resolvedOld)}" cancelled.`);
          }
          if (confirmation.status === "mismatch") {
            return errorResult(
              `Confirmation path did not match "${displayWriteValue(resolvedNew)}"; move aborted.`,
            );
          }
        }
        const result = await moveNote(vaultPath, resolvedOld, resolvedNew, { updateLinks });
        const lines: string[] = [
          `Moved note from '${displayWriteValue(resolvedOld)}' to '${displayWriteValue(resolvedNew)}'.`,
        ];
        if (updateLinks !== false) {
          const updated = result.updatedReferrers.length;
          lines.push(
            updated === 0
              ? "No other notes referenced this file — nothing to rewrite."
              : `Updated references in ${updated} file(s).`,
          );
          if (result.failedReferrers.length > 0) {
            // Cap at 5 so a vault with hundreds of failures (e.g. a perms
            // glitch under a big folder) doesn't blow up the response.
            // Filenames are attacker-controllable, so escape control chars
            // in `path` and route `error` through `sanitizeError` to prevent
            // a `\n`-bearing name from injecting text into LLM context.
            const MAX_DISPLAY = 5;
            lines.push(`Warning: ${result.failedReferrers.length} file(s) could not be updated:`);
            for (const f of result.failedReferrers.slice(0, MAX_DISPLAY)) {
              lines.push(formatFailedPath(f.path, f.error));
            }
            const remaining = result.failedReferrers.length - MAX_DISPLAY;
            if (remaining > 0) {
              lines.push(`  ...and ${remaining} more`);
            }
          }
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("move_note failed", { tool: "move_note", err: err as Error });
        return errorResult(`Error moving note: ${sanitizeError(err)}`);
      }
    },
  );

  // 7. delete_note
  server.registerTool(
    "delete_note",
    {
      title: "Delete Note",
      description:
        "Delete a note. By default the file is moved to the vault's .trash folder (recoverable inside Obsidian); pass permanent=true to unlink it from disk immediately. When permanent=true, you can additionally pass removeReferences=true to strip wikilinks and markdown links to the deleted file across the vault (embeds are removed entirely; plain links fall back to their visible text). References are never rewritten when the file moves to .trash, since trashed files are recoverable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe("Relative path from vault root to the note to delete (e.g., 'archive/old.md'). Extension optional."),
        permanent: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, delete the file permanently from disk; if false (default), move it to the vault's .trash folder so it can be recovered."),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe("Safety latch: must be set to true when permanent=true to confirm the caller intends irreversible deletion. Ignored when permanent=false (trash deletes are recoverable). If permanent=true and confirm is not true, the tool returns an error without deleting."),
        removeReferences: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true (and permanent=true), strip wikilinks and markdown links pointing at the deleted file across the vault. Embeds are removed entirely; plain links fall back to their visible text (alias if present, else the deleted file's basename). Ignored when permanent=false. Default false — opt in explicitly because the rewrite is irreversible."),
      },
    },
    async ({ path: notePath, permanent, confirm, removeReferences }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);

        // Hard gate: permanent deletes require the caller to set confirm=true.
        // This protects against accidental permanent deletion in clients that
        // don't support elicitation. Trash deletes (permanent=false) are
        // recoverable, so no confirmation is needed for those.
        if (permanent && !confirm) {
          return errorResult(
            `Permanent deletion of "${displayWriteValue(resolvedPath)}" requires confirm=true. ` +
            "This is a destructive, irreversible operation. Set confirm to true to proceed, " +
            "or omit permanent (or set it to false) to move the note to the vault's .trash folder instead.",
          );
        }

        // Elicit a typed confirmation before permanent deletion if the client
        // declares elicitation support. Trash deletes (`permanent: false`)
        // are recoverable, so we don't gate them. Errors from the elicit
        // path (network blip, schema mismatch, client that announced
        // elicitation but can't actually fulfil it) fall through to the
        // delete: the tool annotation `destructiveHint: true` already gives
        // the host a chance to confirm, so this is a defense-in-depth
        // check, not a mandatory gate.
        //
        // The MCP spec defines the capability as `elicitation: {}` at the
        // top level; `form` is a TypeScript-SDK extension. Checking only
        // for `.form` silently skipped this gate for spec-compliant
        // clients that declared `elicitation: {}` but not the SDK-specific
        // `form` sub-field, letting permanent deletes proceed without any
        // confirmation prompt. Check the parent key instead so any
        // elicitation-capable client triggers the prompt; if the client
        // can't actually elicit, `elicitInput` throws and the surrounding
        // try/catch logs and falls through.
        const caps = server.server.getClientCapabilities();
        if (permanent && caps?.elicitation !== undefined) {
          try {
            const elicit = await server.server.elicitInput({
              message:
                `Permanently delete "${displayWriteValue(resolvedPath)}" from the vault?` +
                (removeReferences ? " References across the vault will also be stripped." : "") +
                ` This cannot be undone. Type the note's path to confirm.`,
              requestedSchema: {
                type: "object",
                properties: {
                  confirmPath: {
                    type: "string",
                    description: "Re-type the path to confirm permanent deletion.",
                  },
                },
                required: ["confirmPath"],
              },
            });
            if (elicit.action !== "accept") {
              return textResult(`Deletion of "${displayWriteValue(resolvedPath)}" cancelled.`);
            }
            // An accept with no content (or a missing field) is treated as
            // a cancel rather than an error: the user dismissed the form
            // without filling it in. Only a non-matching string counts as
            // a true confirmation failure worth surfacing as an error.
            const content = elicit.content as { confirmPath?: unknown } | undefined;
            const confirmed = content?.confirmPath;
            if (confirmed === undefined || confirmed === null || confirmed === "") {
              return textResult(`Deletion of "${displayWriteValue(resolvedPath)}" cancelled (no confirmation provided).`);
            }
            if (typeof confirmed !== "string" || confirmed.trim() !== resolvedPath) {
              return errorResult(
                `Confirmation path did not match "${displayWriteValue(resolvedPath)}"; deletion aborted.`,
              );
            }
          } catch (err) {
            log.warn("delete_note: elicitation skipped", { err: err as Error });
          }
        }

        const result = await deleteNote(vaultPath, resolvedPath, { permanent, removeReferences });
        const method = permanent ? "permanently deleted" : "moved to trash";
        const lines: string[] = [`Note '${displayWriteValue(resolvedPath)}' ${method}.`];
        if (removeReferences && permanent) {
          const updated = result.updatedReferrers.length;
          lines.push(
            updated === 0
              ? "No other notes referenced this file — nothing to strip."
              : `Stripped references in ${updated} file(s).`,
          );
          if (result.failedReferrers.length > 0) {
            const MAX_DISPLAY = 5;
            lines.push(`Warning: ${result.failedReferrers.length} file(s) could not be updated:`);
            for (const f of result.failedReferrers.slice(0, MAX_DISPLAY)) {
              lines.push(formatFailedPath(f.path, f.error));
            }
            const remaining = result.failedReferrers.length - MAX_DISPLAY;
            if (remaining > 0) {
              lines.push(`  ...and ${remaining} more`);
            }
          }
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("delete_note failed", { tool: "delete_note", err: err as Error });
        return errorResult(`Error deleting note: ${sanitizeError(err)}`);
      }
    },
  );
}
