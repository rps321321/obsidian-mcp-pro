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
import path from "path";

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
    resolveVaultPath(vaultPath, relativePath); // validates path
    await fs.access(path.resolve(vaultPath, relativePath));
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
      description: "Create a new note with optional frontmatter and content",
      inputSchema: {
        path: z.string().min(1).describe("Relative path like 'folder/note.md'"),
        content: z.string().describe("Note content"),
        frontmatter: z
          .string()
          .optional()
          .describe("JSON string of key-value pairs to add as YAML frontmatter"),
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
      description: "Append content to the end of an existing note",
      inputSchema: {
        path: z.string().min(1).describe("Relative path to the note"),
        content: z.string().describe("Content to append"),
        ensureNewline: z
          .boolean()
          .optional()
          .default(true)
          .describe("Ensure content starts on a new line (default: true)"),
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
      description: "Prepend content to a note, after frontmatter if present",
      inputSchema: {
        path: z.string().min(1).describe("Relative path to the note"),
        content: z.string().describe("Content to prepend"),
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
      description: "Update frontmatter properties of a note without changing the body content",
      inputSchema: {
        path: z.string().min(1).describe("Relative path to the note"),
        properties: z
          .string()
          .describe("JSON string of key-value pairs to set in frontmatter"),
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
      description: "Create today's daily note or a note for a specific date",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe("Date in YYYY-MM-DD format (defaults to today)"),
        content: z.string().optional().describe("Initial content for the daily note"),
        templatePath: z
          .string()
          .optional()
          .describe("Path to a template note to use (replaces {{date}} placeholder)"),
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
        const notePath = `${folder}${dateStr}.md`;

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
      description: "Move or rename a note to a new path",
      inputSchema: {
        oldPath: z.string().min(1).describe("Current relative path of the note"),
        newPath: z.string().min(1).describe("New relative path for the note"),
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
      description: "Delete a note (moves to vault trash by default)",
      inputSchema: {
        path: z.string().min(1).describe("Relative path to the note"),
        permanent: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, permanently delete instead of moving to trash"),
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
