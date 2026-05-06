import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listBaseFiles, readBaseFile, listNotes, readNote } from "../lib/vault.js";
import { parseBaseFile, queryBase, buildRow } from "../lib/bases.js";
import { mapConcurrent } from "../lib/concurrency.js";
import { sanitizeError } from "../lib/errors.js";
import { log } from "../lib/logger.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
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
        const lines = [`Found ${bases.length} Base file(s):`, "", ...bases];
        return textResult(lines.join("\n"));
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
          .describe("Vault-relative path to the .base file."),
      },
    },
    async ({ path: basePath }) => {
      try {
        const raw = await readBaseFile(vaultPath, basePath);
        const { doc, warnings } = parseBaseFile(raw);
        const lines: string[] = [`Base: ${basePath}`, ""];
        if (warnings.length > 0) {
          lines.push("Parse warnings:");
          for (const w of warnings) lines.push(`  - ${w}`);
          lines.push("");
        }
        lines.push("Filters:");
        lines.push("  " + JSON.stringify(doc.filters ?? null, null, 2).split("\n").join("\n  "));
        lines.push("");
        if (doc.properties) {
          lines.push(`Properties (${Object.keys(doc.properties).length}):`);
          for (const [key, spec] of Object.entries(doc.properties)) {
            lines.push(`  - ${key}${spec.displayName ? ` (display: ${spec.displayName})` : ""}`);
          }
          lines.push("");
        }
        if (Array.isArray(doc.views) && doc.views.length > 0) {
          lines.push(`Views (${doc.views.length}):`);
          for (const v of doc.views) {
            const nm = v.name ?? "(unnamed)";
            lines.push(`  - ${nm} [type: ${v.type}]`);
          }
        }
        return textResult(lines.join("\n"));
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
        "Run a Base file's filters against the vault and return matching note paths. Optionally pick a named view to apply that view's filters and ordering on top of the base-level filters. Supported filter syntax (subset of Obsidian's full DSL): function calls `taggedWith(file, \"tag\")`, `file.hasTag(\"tag\")`, `file.inFolder(\"path\")`; comparisons `key == \"val\"`, `key != x`, `key contains x`, `>=`, `<=`, `>`, `<`; combinators `and:`, `or:`, `not:`. Unsupported clauses are reported as warnings and treated as match-all.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path to the .base file."),
        view: z
          .string()
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
        const rows = await mapConcurrent(notes, 16, async (notePath) => {
          const content = await readNote(vaultPath, notePath);
          return buildRow(notePath, content);
        });
        const validRows = rows.filter((r): r is NonNullable<typeof r> => r !== undefined);
        const result = queryBase(validRows, doc, view);
        const allWarnings = [...warnings, ...result.warnings];
        const truncated = result.rows.slice(0, limit);

        const lines: string[] = [];
        lines.push(`Base: ${basePath}${view ? ` (view: ${view})` : ""}`);
        lines.push(
          `Matched ${result.rows.length} note(s)${result.rows.length > limit ? ` (showing first ${limit})` : ""}`,
        );
        if (allWarnings.length > 0) {
          lines.push("");
          lines.push("Warnings:");
          for (const w of allWarnings) lines.push(`  - ${w}`);
        }
        lines.push("");
        for (const row of truncated) {
          lines.push(`- ${row.path}`);
          if (includeFrontmatter && Object.keys(row.frontmatter).length > 0) {
            for (const [k, v] of Object.entries(row.frontmatter)) {
              lines.push(`    ${k}: ${JSON.stringify(v)}`);
            }
          }
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        log.error("query_base failed", { tool: "query_base", err: err as Error });
        return errorResult(`Error querying base: ${sanitizeError(err)}`);
      }
    },
  );
}
