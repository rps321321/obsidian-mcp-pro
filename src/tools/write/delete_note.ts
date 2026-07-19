import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteNote } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { defineTool, text, error, richText } from "../../lib/tool-seam.js";
import { log } from "../../lib/logger.js";
import { displayWriteValue, ensureMdExtension } from "./shared.js";

export function registerDeleteNote(server: McpServer, vaultPath: string): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "delete_note",
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
          .describe(
            "Relative path from vault root to the note to delete (e.g., 'archive/old.md'). Extension optional."
          ),
        permanent: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, delete the file permanently from disk; if false (default), move it to the vault's .trash folder so it can be recovered."
          ),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Safety latch: must be set to true when permanent=true to confirm the caller intends irreversible deletion. Ignored when permanent=false (trash deletes are recoverable). If permanent=true and confirm is not true, the tool returns an error without deleting."
          ),
        removeReferences: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true (and permanent=true), strip wikilinks and markdown links pointing at the deleted file across the vault. Embeds are removed entirely; plain links fall back to their visible text (alias if present, else the deleted file's basename). Ignored when permanent=false. Default false — opt in explicitly because the rewrite is irreversible."
          ),
      },
    },
    async ({ path: notePath, permanent, confirm, removeReferences }) => {
      const resolvedPath = ensureMdExtension(notePath);

      // Hard gate: permanent deletes require the caller to set confirm=true.
      // This protects against accidental permanent deletion in clients that
      // don't support elicitation. Trash deletes (permanent=false) are
      // recoverable, so no confirmation is needed for those.
      if (permanent && !confirm) {
        return error(
          `Permanent deletion of "${displayWriteValue(resolvedPath)}" requires confirm=true. ` +
            "This is a destructive, irreversible operation. Set confirm to true to proceed, " +
            "or omit permanent (or set it to false) to move the note to the vault's .trash folder instead."
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
              (removeReferences
                ? " References across the vault will also be stripped."
                : "") +
              ` This cannot be undone. Type the note's path to confirm.`,
            requestedSchema: {
              type: "object",
              properties: {
                confirmPath: {
                  type: "string",
                  description:
                    "Re-type the path to confirm permanent deletion.",
                },
              },
              required: ["confirmPath"],
            },
          });
          if (elicit.action !== "accept") {
            return text(
              `Deletion of "${displayWriteValue(resolvedPath)}" cancelled.`
            );
          }
          // An accept with no content (or a missing field) is treated as
          // a cancel rather than an error: the user dismissed the form
          // without filling it in. Only a non-matching string counts as
          // a true confirmation failure worth surfacing as an error.
          const content = elicit.content as
            { confirmPath?: unknown } | undefined;
          const confirmed = content?.confirmPath;
          if (
            confirmed === undefined ||
            confirmed === null ||
            confirmed === ""
          ) {
            return text(
              `Deletion of "${displayWriteValue(resolvedPath)}" cancelled (no confirmation provided).`
            );
          }
          if (
            typeof confirmed !== "string" ||
            confirmed.trim() !== resolvedPath
          ) {
            return error(
              `Confirmation path did not match "${displayWriteValue(resolvedPath)}"; deletion aborted.`
            );
          }
        } catch (err) {
          log.warn("delete_note: elicitation skipped", { err: err as Error });
        }
      }

      const result = await deleteNote(vaultPath, resolvedPath, {
        permanent,
        removeReferences,
      });
      const method = permanent ? "permanently deleted" : "moved to trash";

      return richText("delete_note failed referrers", (b) => {
        b.trusted(`Note '${displayWriteValue(resolvedPath)}' ${method}.`);
        if (removeReferences && permanent) {
          const updated = result.updatedReferrers.length;
          b.trusted(
            updated === 0
              ? "No other notes referenced this file — nothing to strip."
              : `Stripped references in ${updated} file(s).`
          );
          if (result.failedReferrers.length > 0) {
            const MAX_DISPLAY = 5;
            b.trusted(
              `Warning: ${result.failedReferrers.length} file(s) could not be updated:`
            );
            for (const f of result.failedReferrers.slice(0, MAX_DISPLAY)) {
              b.untrusted(
                "delete_note failed referrer",
                `- ${displayWriteValue(f.path)}: ${sanitizeError(f.error)}`,
                "  "
              );
            }
            const remaining = result.failedReferrers.length - MAX_DISPLAY;
            if (remaining > 0) {
              b.trusted("  ...and " + remaining + " more");
            }
          }
        }
      });
    }
  );
}
