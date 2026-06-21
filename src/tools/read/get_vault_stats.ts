import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes } from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { untrustedVaultContentMeta } from "../../lib/tool-output.js";
import { parseFrontmatter, extractTags } from "../../lib/markdown.js";
import { displayReadValue, errorResult, untrustedReadBlock } from "./shared.js";

export function registerGetVaultStatsTool(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_vault_stats",
    {
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
          .describe("Restrict stats to this folder (relative to vault root). Omit for whole-vault stats."),
      },
    },
    async ({ folder }) => {
      try {
        const notes = await listNotes(vaultPath, folder);
        if (notes.length === 0) {
          return { content: [{ type: "text" as const, text: folder ? `No notes in "${displayReadValue(folder)}"` : "Vault is empty." }] };
        }
        const { contents, stats } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("get_vault_stats: note read failed", { note, err });
        });

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
        const lines = [
          `Vault stats${folder ? ` (folder: ${displayReadValue(folder)})` : ""}`,
          "",
          `  Notes:           ${notes.length}`,
          `  Total bytes:     ${totalBytes.toLocaleString()}`,
          `  Total words:     ${totalWords.toLocaleString()}`,
          `  Avg bytes/note:  ${avgBytes.toLocaleString()}`,
          `  Avg words/note:  ${avgWords.toLocaleString()}`,
          `  Unique tags:     ${tagSet.size}`,
          `  Untagged notes:  ${untagged} (${untaggedPct}%)`,
        ];
        if (mostRecent) {
          lines.push("  Most recent:");
          lines.push(untrustedReadBlock(
            "get_vault_stats most recent path",
            `${displayReadValue(mostRecent.path)} (${new Date(mostRecent.mtimeMs).toISOString()})`,
            "    ",
          ));
        } else {
          lines.push("  Most recent:     (none)");
        }
        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            ...(mostRecent ? { _meta: untrustedVaultContentMeta("get_vault_stats most recent path") } : {}),
          }],
        };
      } catch (err) {
        log.error("get_vault_stats failed", { tool: "get_vault_stats", err: err as Error });
        return errorResult(`Error gathering vault stats: ${sanitizeError(err)}`);
      }
    },
  );
}
