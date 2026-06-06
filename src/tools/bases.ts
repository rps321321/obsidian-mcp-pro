import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listBaseFiles, readBaseFile, listNotes } from "../lib/vault.js";
import { parseBaseFile, queryBase, buildRow } from "../lib/bases.js";
import { readAllCached } from "../lib/index-cache.js";
import { extractWikilinks } from "../lib/markdown.js";
import { escapeControlChars, sanitizeError } from "../lib/errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "../lib/tool-output.js";
import { log } from "../lib/logger.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function untrustedTextResult(label: string, text: string) {
  return {
    content: [{
      type: "text" as const,
      text,
      _meta: untrustedVaultContentMeta(label),
    }],
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Escape control characters before embedding values in Base tool display text. */
const displayBaseValue = escapeControlChars;

function untrustedBaseBlock(label: string, text: string, indent = ""): string {
  return indentBlock(formatUntrustedVaultContent(label, text), indent);
}

export function registerBaseTools(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_bases",
    {
      title: "List Bases",
      description:
        "Enumerate every Obsidian Bases (`.base`) file in the vault. Bases are YAML-defined database views over notes (filters, properties, table/calendar/kanban views). Returns a sorted list of relative paths plus the total count. Pair with read_base or query_base.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const bases = await listBaseFiles(vaultPath);
        if (bases.length === 0) return textResult("No .base files in this vault.");
        const lines = [`Found ${bases.length} Base file(s):`, ""];
        lines.push(untrustedBaseBlock("list_bases paths", bases.map(displayBaseValue).join("\n")));
        return untrustedTextResult("list_bases paths", lines.join("\n"));
      } catch (err) {
        log.error("list_bases failed", { tool: "list_bases", err: err as Error });
        return errorResult(`Error listing bases: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "read_base",
    {
      title: "Read Base",
      description:
        "Return the parsed contents of a Base file: filters, properties, view definitions, and any unrecognized fields. Use to discover what queries a Base supports before calling query_base.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .regex(/\.base$/i, "Path must end in .base")
          .describe("Vault-relative path to the .base file."),
      },
    },
    async ({ path: basePath }) => {
      try {
        const raw = await readBaseFile(vaultPath, basePath);
        const { doc, warnings } = parseBaseFile(raw);
        const lines: string[] = [`Base: ${displayBaseValue(basePath)}`, ""];
        if (warnings.length > 0) {
          lines.push("Parse warnings:");
          for (const w of warnings) lines.push(`  - ${displayBaseValue(w)}`);
          lines.push("");
        }
        lines.push("Filters:");
        lines.push("  " + JSON.stringify(doc.filters ?? null, null, 2).split("\n").join("\n  "));
        lines.push("");
        if (doc.properties) {
          lines.push(`Properties (${Object.keys(doc.properties).length}):`);
          for (const [key, spec] of Object.entries(doc.properties)) {
            lines.push(
              `  - ${displayBaseValue(key)}${spec.displayName ? ` (display: ${displayBaseValue(spec.displayName)})` : ""}`,
            );
          }
          lines.push("");
        }
        if (Array.isArray(doc.views) && doc.views.length > 0) {
          lines.push(`Views (${doc.views.length}):`);
          for (const v of doc.views) {
            const nm = v.name ?? "(unnamed)";
            lines.push(`  - ${displayBaseValue(nm)} [type: ${displayBaseValue(v.type)}]`);
          }
        }
        return untrustedTextResult(
          "read_base document",
          formatUntrustedVaultContent("read_base document", lines.join("\n")),
        );
      } catch (err) {
        log.error("read_base failed", { tool: "read_base", err: err as Error });
        return errorResult(`Error reading base: ${sanitizeError(err)}`);
      }
    },
  );

  server.registerTool(
    "query_base",
    {
      title: "Query Base",
      description:
        "Run a Base file's filters against the vault and return matching note paths. Optionally pick a named view to apply that view's filters and ordering on top of the base-level filters. Supported filter syntax (subset of Obsidian's full DSL): chained methods `file.hasTag(\"tag\")`, `file.hasProperty(\"key\")`, `file.inFolder(\"path\")`, `file.linksTo(\"target\")`, `file.name.contains(\"x\")`/`.startsWith`/`.endsWith`/`.equals`, plus `.isEmpty`/`.isNotEmpty` on any value; legacy function form `taggedWith(file, \"tag\")`; comparisons `key == \"val\"`, `key != x`, `key contains x`, `>=`, `<=`, `>`, `<`; combinators `and:`, `or:`, `not:`. Recognized file properties: file.name, file.basename, file.folder, file.ext, file.path, file.size, file.ctime, file.mtime, file.tags, file.properties, file.links, file.embeds, file.backlinks. Unsupported clauses are reported as warnings and treated as no-match.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .regex(/\.base$/i, "Path must end in .base")
          .describe("Vault-relative path to the .base file."),
        view: z
          .string()
          .max(5000)
          .optional()
          .describe("Optional view name (or view type) to apply on top of the base-level filters."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum number of matching notes to return (1-1000, default: 100)."),
        includeFrontmatter: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, include each row's frontmatter in the output."),
      },
    },
    async ({ path: basePath, view, limit, includeFrontmatter }) => {
      try {
        const raw = await readBaseFile(vaultPath, basePath);
        const { doc, warnings } = parseBaseFile(raw);
        const notes = await listNotes(vaultPath);
        // PERF-4: Use the mtime-keyed content cache instead of reading each
        // note individually. readAllCached stat()'s each path and only re-reads
        // files whose mtime has moved, which makes repeat queries near-instant.
        const readFailures: string[] = [];
        const { contents, stats } = await readAllCached(vaultPath, notes, (relPath, err) => {
          readFailures.push(relPath);
          log.warn("query_base: note read failed", {
            note: relPath,
            err,
          });
        });
        const validRows = notes
          .filter((notePath) => contents.has(notePath))
          .map((notePath) => {
            const content = contents.get(notePath)!;
            const row = buildRow(notePath, content, stats.get(notePath));
            // BUG-4: Populate row.links from the note's outgoing wikilinks so
            // file.linksTo() / file.hasLink() filters evaluate correctly.
            // Without this, row.links is undefined and link filters fail
            // closed with a warning.
            const linkInfos = extractWikilinks(content);
            row.links = linkInfos
              .filter((l) => !l.isEmbed)
              .map((l) => l.target);
            row.embeds = linkInfos
              .filter((l) => l.isEmbed)
              .map((l) => l.target);
            return row;
          });
        const result = queryBase(validRows, doc, view);
        const allWarnings = [...warnings, ...result.warnings];
        if (readFailures.length > 0) {
          allWarnings.push(
            `Could not read ${readFailures.length} note(s); they were excluded from results.`,
          );
        }
        const truncated = result.rows.slice(0, limit);

        const lines: string[] = [];
        lines.push("Base:");
        lines.push(untrustedBaseBlock("query_base base path", displayBaseValue(basePath), "  "));
        if (view) lines.push(`View: ${displayBaseValue(view)}`);
        lines.push(
          `Matched ${result.rows.length} note(s)${result.rows.length > limit ? ` (showing first ${limit})` : ""}`,
        );
        if (allWarnings.length > 0) {
          lines.push("");
          lines.push("Warnings:");
          lines.push(untrustedBaseBlock(
            "query_base warnings",
            allWarnings.map((w) => `- ${displayBaseValue(w)}`).join("\n"),
            "  ",
          ));
        }
        lines.push("");
        if (includeFrontmatter) {
          for (const row of truncated) {
            lines.push(untrustedBaseBlock(
              "query_base row path",
              `- ${displayBaseValue(row.path)}`,
            ));
            if (Object.keys(row.frontmatter).length > 0) {
              const frontmatterLines: string[] = [];
              for (const [k, v] of Object.entries(row.frontmatter)) {
                frontmatterLines.push(`${displayBaseValue(k)}: ${JSON.stringify(v)}`);
              }
              lines.push(indentBlock(
                formatUntrustedVaultContent("query_base row frontmatter", frontmatterLines.join("\n")),
                "    ",
              ));
            }
          }
        } else if (truncated.length > 0) {
          lines.push(untrustedBaseBlock(
            "query_base result paths",
            truncated.map((row) => `- ${displayBaseValue(row.path)}`).join("\n"),
          ));
        }
        return untrustedTextResult(
          includeFrontmatter ? "query_base paths and frontmatter" : "query_base paths",
          lines.join("\n"),
        );
      } catch (err) {
        log.error("query_base failed", { tool: "query_base", err: err as Error });
        return errorResult(`Error querying base: ${sanitizeError(err)}`);
      }
    },
  );
}
