import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readBaseFile } from "../../lib/vault.js";
import { parseBaseFile } from "../../lib/bases.js";
import { defineTool, untrustedText } from "../../lib/tool-seam.js";
import { displayBaseValue } from "./shared.js";

export function registerReadBase(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "read_base",
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
      return untrustedText("read_base document", lines.join("\n"));
    },
  );
}
