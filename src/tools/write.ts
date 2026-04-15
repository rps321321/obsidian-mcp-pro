import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import matter from "gray-matter";
import {
  writeNote,
  appendToNote,
  prependToNote,
  deleteNote,
  moveNote,
  readNote,
  resolveVaultPath,
} from "../lib/vault.js";
import { updateFrontmatter } from "../lib/markdown.js";
import { getDailyNoteConfig } from "../config.js";
import fs from "fs/promises";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function ensureMdExtension(filePath: string): string {
  return /\.md$/i.test(filePath) ? filePath : `${filePath}.md`;
}

function formatDate(date: Date, format: string): string {
  const yyyy = date.getFullYear().toString();
  const mm = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");

  return format
    .replace("YYYY", yyyy)
    .replace("MM", mm)
    .replace("DD", dd);
}

function buildFrontmatterContent(frontmatterObj: Record<string, unknown>, body: string): string {
  return matter.stringify(body, frontmatterObj);
}

async function noteExists(vaultPath: string, relativePath: string): Promise<boolean> {
  try {
    const resolved = resolveVaultPath(vaultPath, relativePath); // validates + returns safe path
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
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
          .describe("Relative path from vault root, e.g., 'folder/note.md' or 'note' (.md added automatically)"),
        content: z
          .string()
          .describe("Markdown body content for the note (rendered below the frontmatter block if any)"),
        frontmatter: z
          .string()
          .optional()
          .describe("JSON object string of frontmatter key-value pairs (e.g., '{\"status\":\"draft\",\"tags\":[\"idea\"]}'). Rendered as YAML at the top of the note."),
      },
    },
    async ({ path: notePath, content, frontmatter }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);

        if (await noteExists(vaultPath, resolvedPath)) {
          return errorResult(`Error: Note already exists at '${resolvedPath}'. Use append or update tools instead.`);
        }

        let finalContent: string;

        if (frontmatter) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(frontmatter) as Record<string, unknown>;
          } catch {
            return errorResult("Error: Invalid JSON in frontmatter parameter.");
          }
          finalContent = buildFrontmatterContent(parsed, content);
        } else {
          finalContent = content;
        }

        await writeNote(vaultPath, resolvedPath, finalContent);
        return textResult(`Created note at '${resolvedPath}'.`);
      } catch (err) {
        console.error("create_note error:", err);
        return errorResult(`Error creating note: ${err instanceof Error ? err.message : String(err)}`);
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
          .describe("Relative path from vault root to the target note (e.g., 'journal/2026-04-15.md'). Extension optional."),
        content: z
          .string()
          .describe("Markdown text to append to the end of the note"),
        ensureNewline: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true, ensures appended content begins on a new line when the file does not already end in a newline (default: true)"),
      },
    },
    async ({ path: notePath, content }) => {
      // ensureNewline is handled by vault.ts appendToNote
      try {
        const resolvedPath = ensureMdExtension(notePath);
        await appendToNote(vaultPath, resolvedPath, content);
        return textResult(`Appended content to '${resolvedPath}'.`);
      } catch (err) {
        console.error("append_to_note error:", err);
        return errorResult(`Error appending to note: ${err instanceof Error ? err.message : String(err)}`);
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
          .describe("Relative path from vault root to the target note (e.g., 'notes/log.md'). Extension optional."),
        content: z
          .string()
          .describe("Markdown text to insert at the top of the body, after any frontmatter"),
      },
    },
    async ({ path: notePath, content }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);
        await prependToNote(vaultPath, resolvedPath, content);
        return textResult(`Prepended content to '${resolvedPath}'.`);
      } catch (err) {
        console.error("prepend_to_note error:", err);
        return errorResult(`Error prepending to note: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 4. update_frontmatter
  server.registerTool(
    "update_frontmatter",
    {
      title: "Update Frontmatter",
      description:
        "Merge new key-value pairs into a note's YAML frontmatter, preserving any keys not mentioned and leaving the body content untouched. Keys in the payload overwrite existing values. Creates a frontmatter block if the note has none. Returns a count of properties written. Use to set status fields, tags arrays, or other metadata without rewriting the body.",
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
          .describe("Relative path from vault root to the note (e.g., 'projects/alpha.md'). Extension optional."),
        properties: z
          .string()
          .describe("JSON object string of frontmatter keys to set, e.g., '{\"status\":\"done\",\"priority\":1,\"tags\":[\"review\"]}'. Existing keys not in the payload are preserved."),
      },
    },
    async ({ path: notePath, properties }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(properties) as Record<string, unknown>;
        } catch {
          return errorResult("Error: Invalid JSON in properties parameter.");
        }

        const existing = await readNote(vaultPath, resolvedPath);
        const updated = updateFrontmatter(existing, parsed);
        await writeNote(vaultPath, resolvedPath, updated);

        return textResult(`Updated frontmatter of '${resolvedPath}' with ${Object.keys(parsed).length} properties.`);
      } catch (err) {
        console.error("update_frontmatter error:", err);
        return errorResult(`Error updating frontmatter: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 5. create_daily_note
  server.registerTool(
    "create_daily_note",
    {
      title: "Create Daily Note",
      description:
        "Create a daily note for today (or a specific date) in the vault's configured daily-note folder using its configured filename format. Optionally seed the note from a template file where occurrences of {{date}} are replaced with the formatted date. Fails if the daily note already exists.",
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
          .optional()
          .describe("Initial markdown body for the daily note. Ignored if templatePath is provided."),
        templatePath: z
          .string()
          .optional()
          .describe("Relative path to a template note. Its content is copied into the new daily note with {{date}} replaced by the formatted date."),
      },
    },
    async ({ date, content, templatePath }) => {
      try {
        const config = getDailyNoteConfig(vaultPath);
        const targetDate = date ? new Date(date + "T00:00:00") : new Date();

        if (isNaN(targetDate.getTime())) {
          return errorResult("Error: Invalid date format. Use YYYY-MM-DD.");
        }

        const dateStr = formatDate(targetDate, config.format);
        const folder = config.folder ? `${config.folder}/` : "";
        const notePath = ensureMdExtension(`${folder}${dateStr}`);

        if (await noteExists(vaultPath, notePath)) {
          return errorResult(`Error: Daily note already exists at '${notePath}'.`);
        }

        let finalContent = content ?? "";

        if (templatePath) {
          try {
            const templateContent = await readNote(vaultPath, templatePath);
            finalContent = templateContent.replace(/\{\{date\}\}/g, dateStr);
          } catch (err) {
            return errorResult(`Error reading template: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        await writeNote(vaultPath, notePath, finalContent);
        return textResult(`Created daily note at '${notePath}'.`);
      } catch (err) {
        console.error("create_daily_note error:", err);
        return errorResult(`Error creating daily note: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 6. move_note
  server.registerTool(
    "move_note",
    {
      title: "Move/Rename Note",
      description:
        "Move or rename a note within the vault, preserving its full content. Parent folders at the destination are created as needed. Note: this does not rewrite wikilinks in other notes that reference the old path — use find_broken_links afterward to spot broken references. A .md extension is added automatically if omitted from either path.",
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
          .describe("Current relative path of the note from vault root (e.g., 'inbox/idea.md')"),
        newPath: z
          .string()
          .min(1)
          .describe("Destination relative path from vault root (e.g., 'projects/idea.md'). Creates intermediate folders as needed."),
      },
    },
    async ({ oldPath, newPath }) => {
      try {
        const resolvedOld = ensureMdExtension(oldPath);
        const resolvedNew = ensureMdExtension(newPath);
        await moveNote(vaultPath, resolvedOld, resolvedNew);
        return textResult(`Moved note from '${resolvedOld}' to '${resolvedNew}'.`);
      } catch (err) {
        console.error("move_note error:", err);
        return errorResult(`Error moving note: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 7. delete_note
  server.registerTool(
    "delete_note",
    {
      title: "Delete Note",
      description:
        "Delete a note. By default the file is moved to the vault's .trash folder (recoverable inside Obsidian); pass permanent=true to unlink it from disk immediately. Note: this does not rewrite wikilinks in other notes that reference the deleted path — run find_broken_links afterward to surface dangling references.",
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
          .describe("Relative path from vault root to the note to delete (e.g., 'archive/old.md'). Extension optional."),
        permanent: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, delete the file permanently from disk; if false (default), move it to the vault's .trash folder so it can be recovered."),
      },
    },
    async ({ path: notePath, permanent }) => {
      try {
        const resolvedPath = ensureMdExtension(notePath);
        const useTrash = !permanent;
        await deleteNote(vaultPath, resolvedPath, useTrash);
        const method = useTrash ? "moved to trash" : "permanently deleted";
        return textResult(`Note '${resolvedPath}' ${method}.`);
      } catch (err) {
        console.error("delete_note error:", err);
        return errorResult(`Error deleting note: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
