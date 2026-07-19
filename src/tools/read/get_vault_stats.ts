import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { log } from "../../lib/logger.js";
import { parseFrontmatter, extractTags } from "../../lib/markdown.js";
import { defineTool, richText, text } from "../../lib/tool-seam.js";
import { escapeControlChars } from "./shared.js";

export function registerGetVaultStatsTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "get_vault_stats",
      title: "Get Vault Stats",
      description:
        "Return a quick health snapshot of the vault: note count, total bytes, total words, unique tag count, untagged-note count, and the most-recently-modified note. Useful for dashboards and 'is this vault healthy?' checks. Reads through the mtime cache so repeat calls are cheap.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Restrict stats to this folder (relative to vault root). Omit for whole-vault stats."
          ),
      },
    },
    async ({ folder }) => {
      const notes = await listNotes(vaultPath, folder);
      if (notes.length === 0) {
        return text(
          folder
            ? `No notes in "${escapeControlChars(folder)}"`
            : "Vault is empty."
        );
      }
      const { contents, stats } = await readAllCached(
        vaultPath,
        notes,
        (note, err) => {
          log.warn("get_vault_stats: note read failed", { note, err });
        }
      );

      // Aggregate over already-cached content and stats. `readAllCached`
      // already resolves and stats each note safely, so most-recent can use
      // that metadata without a second filesystem pass.
      let totalBytes = 0;
      let totalWords = 0;
      let untagged = 0;
      const tagSet = new Set<string>();
      let mostRecent: { path: string; mtimeMs: number } | null = null;
      for (const notePath of notes) {
        const stat = stats.get(notePath);
        if (stat && (!mostRecent || stat.mtime > mostRecent.mtimeMs)) {
          mostRecent = { path: notePath, mtimeMs: stat.mtime };
        }
        const content = contents.get(notePath);
        if (content === undefined) continue;
        totalBytes += Buffer.byteLength(content, "utf-8");
        const { content: body } = parseFrontmatter(content);
        const wordMatches = body.match(/\S+/g);
        totalWords += wordMatches ? wordMatches.length : 0;
        const tags = extractTags(content);
        if (tags.length === 0) untagged++;
        for (const t of tags) tagSet.add(t.toLowerCase());
      }

      const avgBytes = Math.round(totalBytes / notes.length);
      const avgWords = Math.round(totalWords / notes.length);
      const untaggedPct = ((untagged / notes.length) * 100).toFixed(1);
      return richText("get_vault_stats most recent path", (b) => {
        b.trusted(
          `Vault stats${folder ? ` (folder: ${escapeControlChars(folder)})` : ""}`
        );
        b.trusted("");
        b.trusted(`  Notes:           ${notes.length}`);
        b.trusted(`  Total bytes:     ${totalBytes.toLocaleString()}`);
        b.trusted(`  Total words:     ${totalWords.toLocaleString()}`);
        b.trusted(`  Avg bytes/note:  ${avgBytes.toLocaleString()}`);
        b.trusted(`  Avg words/note:  ${avgWords.toLocaleString()}`);
        b.trusted(`  Unique tags:     ${tagSet.size}`);
        b.trusted(`  Untagged notes:  ${untagged} (${untaggedPct}%)`);
        if (mostRecent) {
          b.trusted("  Most recent:");
          b.untrusted(
            "get_vault_stats most recent path",
            `${escapeControlChars(mostRecent.path)} (${new Date(mostRecent.mtimeMs).toISOString()})`,
            "    "
          );
        } else {
          b.trusted("  Most recent:     (none)");
        }
      });
    }
  );
}
