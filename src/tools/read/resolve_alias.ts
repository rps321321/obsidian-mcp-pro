import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import { listNotes } from "../../lib/vault.js";
import { readAllCached } from "../../lib/index-cache.js";
import { sanitizeError } from "../../lib/errors.js";
import { log } from "../../lib/logger.js";
import { untrustedVaultContentMeta } from "../../lib/tool-output.js";
import { extractAliases } from "../../lib/markdown.js";
import { displayReadValue, errorResult, untrustedReadBlock } from "./shared.js";

export function registerResolveAliasTool(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "resolve_alias",
    {
      title: "Resolve Alias",
      description:
        "Find every note whose frontmatter `aliases:` field contains the given name (case-insensitive). With `includeBasename: true`, also matches notes whose filename (without `.md`) equals the name — Obsidian's resolution fallback when no alias matches. Use to translate a human-friendly title like 'My Project' into the actual note path before calling get_note.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(500)
          .describe("Alias or display name to resolve, e.g. 'My Project'."),
        includeBasename: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), also match notes whose filename (without extension) equals `name`."),
      },
    },
    async ({ name, includeBasename }) => {
      try {
        const target = name.trim().toLowerCase();
        if (!target) return errorResult("name must not be empty");
        const notes = await listNotes(vaultPath);

        // Basename matches are a pure path comparison - no file I/O needed.
        const basenameMatches: string[] = [];
        if (includeBasename) {
          for (const notePath of notes) {
            const basename = path.basename(notePath, path.extname(notePath)).toLowerCase();
            if (basename === target) basenameMatches.push(notePath);
          }
        }

        // For alias matches, read through the shared content cache so repeat
        // lookups reuse warm note bodies while preserving per-note path checks.
        const aliasMatches: string[] = [];
        const { contents } = await readAllCached(vaultPath, notes, (note, err) => {
          log.warn("resolve_alias: note read failed", { note, err });
        });
        for (const notePath of notes) {
          const content = contents.get(notePath);
          if (content === undefined) continue;
          const aliases = extractAliases(content);
          if (aliases.some((a) => a.toLowerCase() === target)) {
            aliasMatches.push(notePath);
          }
        }

        const total = aliasMatches.length + basenameMatches.length;
        if (total === 0) {
          return { content: [{ type: "text" as const, text: `No alias or basename match for "${displayReadValue(name)}"` }] };
        }

        const lines: string[] = [`Matches for "${displayReadValue(name)}":`, ""];
        if (aliasMatches.length > 0) {
          lines.push(`Alias matches (${aliasMatches.length}):`);
          lines.push(untrustedReadBlock(
            "resolve_alias alias paths",
            aliasMatches.map((p) => `- ${displayReadValue(p)}`).join("\n"),
            "  ",
          ));
        }
        if (basenameMatches.length > 0) {
          if (aliasMatches.length > 0) lines.push("");
          lines.push(`Basename matches (${basenameMatches.length}):`);
          lines.push(untrustedReadBlock(
            "resolve_alias basename paths",
            basenameMatches.map((p) => `- ${displayReadValue(p)}`).join("\n"),
            "  ",
          ));
        }
        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
            _meta: untrustedVaultContentMeta(
              aliasMatches.length > 0 ? "resolve_alias alias paths" : "resolve_alias basename paths",
            ),
          }],
        };
      } catch (err) {
        log.error("resolve_alias failed", { tool: "resolve_alias", err: err as Error });
        return errorResult(`Error resolving alias: ${sanitizeError(err)}`);
      }
    },
  );
}
