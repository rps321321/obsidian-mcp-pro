import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateNote } from "../../lib/vault.js";
import { sanitizeError } from "../../lib/errors.js";
import { defineTool, text, error } from "../../lib/tool-seam.js";
import {
  FIND_MAX_LEN,
  SECTION_EDIT_PAYLOAD_MAX_CHARS,
  NOTE_INPUT_MAX_LEN,
  escapeControlChars,
  assertReadableEditTarget,
  invalidateSectionListCache,
  hasUnsafeRepeatedGroup,
} from "./shared.js";

export function registerReplaceInNoteTool(
  server: McpServer,
  vaultPath: string
): void {
  defineTool(
    server,
    vaultPath,
    {
      name: "replace_in_note",
      title: "Replace in Note",
      description:
        "Search-and-replace within a single note. Supports literal strings or regex patterns. With `expectedCount`, the operation refuses to commit unless that many matches are present, guarding against accidental over-replacement when an LLM drafts a pattern that's too broad. Returns the count of replacements made.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note."),
        find: z
          .string()
          .min(1)
          .max(FIND_MAX_LEN)
          .describe("Literal string (default) or regex pattern to match."),
        replace: z
          .string()
          .max(SECTION_EDIT_PAYLOAD_MAX_CHARS)
          .describe(
            "Replacement text. With `regex: true`, supports $1, $2 backreferences."
          ),
        regex: z
          .boolean()
          .default(false)
          .describe(
            "Treat `find` as a JavaScript regex (multi-line, case-sensitive by default)."
          ),
        flags: z
          .string()
          .optional()
          .describe(
            "Regex flags (e.g., 'gi'). Defaults to 'g' so all matches are replaced."
          ),
        expectedCount: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "If set, abort unless exactly this many matches are found."
          ),
      },
    },
    async ({ path: notePath, find, replace, regex, flags, expectedCount }) => {
      const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

      let pattern: RegExp;
      let unsafeRegexPattern = false;
      if (regex) {
        if (find.length > FIND_MAX_LEN) {
          return error(
            `Error replacing in note: find pattern too long (${find.length} > ${FIND_MAX_LEN} chars). Use a more targeted pattern.`
          );
        }
        const f = flags ?? "g";
        const seen = new Set<string>();
        for (const ch of f) {
          if (!ALLOWED_FLAGS.has(ch)) {
            return error(
              `Error replacing in note: invalid regex flag '${escapeControlChars(ch)}'. Allowed flags: g, i, m, s, u, y.`
            );
          }
          if (seen.has(ch)) {
            return error(
              `Error replacing in note: duplicate regex flag '${escapeControlChars(ch)}'.`
            );
          }
          seen.add(ch);
        }
        if (!f.includes("g")) {
          return error(
            "Error replacing in note: regex flags must include 'g' for replace_in_note."
          );
        }
        let compiledPattern: RegExp;
        try {
          compiledPattern = new RegExp(find, f);
        } catch (syntaxErr) {
          return error(
            `Error replacing in note: invalid regex pattern: ${sanitizeError(syntaxErr)}`
          );
        }
        unsafeRegexPattern = hasUnsafeRepeatedGroup(find);
        pattern = compiledPattern;
      } else {
        const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pattern = new RegExp(escaped, "g");
      }

      let count = 0;
      await assertReadableEditTarget(vaultPath, notePath);
      await updateNote(vaultPath, notePath, (existing) => {
        if (existing.length > NOTE_INPUT_MAX_LEN) {
          throw new Error(
            `note is too large for replace_in_note (${existing.length} > ${NOTE_INPUT_MAX_LEN} chars). Use a more targeted tool.`
          );
        }
        if (unsafeRegexPattern) {
          throw new Error(
            "unsafe regex pattern: nested quantifiers or ambiguous repeated alternation can cause catastrophic backtracking. Use a simpler pattern."
          );
        }
        const matches = existing.match(pattern);
        count = matches ? matches.length : 0;
        if (expectedCount !== undefined && count !== expectedCount) {
          throw new Error(
            `Match-count check failed: expected ${expectedCount}, found ${count}. No changes written.`
          );
        }
        if (count === 0) return existing;
        return regex
          ? existing.replace(pattern, replace)
          : existing.replace(pattern, () => replace);
      });
      invalidateSectionListCache(vaultPath, notePath);
      return text(
        count === 0
          ? `No matches in ${escapeControlChars(notePath)} - file unchanged.`
          : `Replaced ${count} match(es) in ${escapeControlChars(notePath)}.`
      );
    }
  );
}
