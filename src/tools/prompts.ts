import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { escapeControlChars } from "../lib/errors.js";

/**
 * MCP prompts the server exposes to clients. Each prompt is a starter
 * conversation template; clients render them in their slash-command palette
 * (Claude Desktop), command picker (Cursor), etc. The prompts here drive
 * common Obsidian workflows: reviewing today's note, rolling up the week,
 * finding stale notes, extracting action items.
 *
 * Prompts intentionally reference the server's own tools by name so the LLM
 * knows exactly which calls to make. They don't pre-fetch vault data; the
 * model fetches on demand using the tools, which keeps the prompt template
 * small and side-effect free.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "daily-review",
    {
      title: "Daily Review",
      description:
        "Walk through today's daily note: pull tasks, links to other notes, and uncompleted items. Suggests follow-ups and tag cleanup.",
      argsSchema: {
        date: z
          .string()
          .max(10)
          .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
          .optional()
          .describe("Target date (defaults to today)"),
      },
    },
    ({ date }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Review my Obsidian daily note${date ? ` for ${date}` : " for today"}.`,
              "",
              "Steps:",
              "1. Call get_daily_note" +
                (date ? ` with date="${date}"` : "") +
                ".",
              "2. Summarize what I worked on (1-3 bullet points).",
              "3. List any unchecked tasks (`- [ ] …`) with the section they came from.",
              '4. Identify wikilinks in the note. Call get_recent_notes with since="7d" and limit=200 once to get the set of notes touched in the last 7 days. Any linked note NOT in that set is a candidate to revisit. List up to 5 such links. Do not call get_note per link.',
              "5. Surface any inline #tags new to today's note that aren't used elsewhere (call get_tags once to compare).",
              "",
              "Keep it tight: a paragraph plus three short lists. No restating the whole note.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "weekly-rollup",
    {
      title: "Weekly Rollup",
      description:
        "Aggregate the last week of daily notes into a single summary: themes, recurring tasks, decisions, and notes worth promoting to permanent ones.",
      argsSchema: {
        endDate: z
          .string()
          .max(10)
          .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
          .optional()
          .describe("Last day of the rollup window (defaults to today)"),
      },
    },
    ({ endDate }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Roll up the last 7 days of daily notes${endDate ? ` ending ${endDate}` : ""} into a single summary.`,
              "",
              "Steps:",
              `1. Call get_recent_notes with since="7d"${endDate ? `, endDate="${endDate}"` : ""} and limit=200 to fetch all notes touched in the 7-day window in a single request. Filter the results to daily notes (by path pattern or folder). If a daily note is missing from the results, note the gap but do not make additional calls per day.`,
              "2. Identify 3-5 recurring themes across the week.",
              "3. List decisions made and their context.",
              "4. Pull all unchecked tasks still open at week end.",
              "5. Suggest 1-3 permanent notes worth creating from this week's material. For each, propose a title, a one-paragraph body, and 2-3 wikilinks to existing notes.",
              "",
              "Output format: Themes / Decisions / Open Tasks / Suggested Permanent Notes. Skip headers if a section is empty.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "find-stale-notes",
    {
      title: "Find Stale Notes",
      description:
        "Locate notes that haven't been edited in N days, prioritizing ones with broken links, no backlinks, or untagged status. Useful for vault hygiene.",
      argsSchema: {
        days: z
          .string()
          .max(10)
          .regex(/^\d+$/, "must be a non-negative integer")
          .optional()
          .describe(
            "Days since last modification to qualify as stale (default: 90)"
          ),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe("Restrict scan to this folder (default: entire vault)"),
      },
    },
    ({ days, folder }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Find stale notes${folder ? ` in folder "${escapeControlChars(folder)}"` : ""} (untouched ${days ?? "90"}+ days).`,
              "",
              "Steps:",
              `1. Call get_recent_notes with limit=1000${folder ? ` and folder="${escapeControlChars(folder)}"` : ""} (no \`since\` filter) to get every note ordered by most-recent-mtime first. Each row already includes an ISO timestamp, so no need to call get_note per row. The stalest notes sit at the bottom of the list.`,
              `2. Filter to notes whose mtime is older than ${days ?? "90"} days. Cap the candidate set at 25. (Optional cross-check: call get_recent_notes a second time with since="${days ?? "90"}d"; anything NOT in that set is stale.)`,
              "3. Call find_orphans once and find_broken_links once. Use the returned paths as lookup sets; do not call get_note per candidate.",
              "4. Group the (already capped) candidates into three buckets using the two lookup sets:",
              "   - Stale + orphaned (low retention value)",
              "   - Stale + broken-linked (need fixing or archiving)",
              "   - Stale + still-linked (candidates for refresh)",
              "5. Only if a frontmatter `modified`/`updated`/`date` key is needed to break ties, call get_note on at most the top 5 candidates. Otherwise rely on the mtime from step 1.",
              "6. For each note in the orphaned bucket, propose: archive (move to /archive), delete, or refresh.",
              "",
              "Output: a short table with columns Path | Bucket | Last touched (ISO) | Recommendation. Cap at 25 rows.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "extract-action-items",
    {
      title: "Extract Action Items",
      description:
        "Pull all action items (`- [ ] …`) from a note (or matching set of notes) and present them in priority order with their source.",
      argsSchema: {
        path: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Single note path. Omit and pass `tag` instead to scan tagged notes."
          ),
        tag: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Tag to scan (e.g. 'project'). Pulls action items from every note with this tag."
          ),
      },
    },
    ({ path, tag }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              path
                ? `Extract action items from "${escapeControlChars(path)}".`
                : tag
                  ? `Extract action items from every note tagged #${escapeControlChars(tag.replace(/^#/, ""))}.`
                  : "Extract action items from the active note.",
              "",
              "Steps:",
              path
                ? `1. Call get_note with path="${escapeControlChars(path)}".`
                : tag
                  ? `1. Call search_by_tag with tag="${escapeControlChars(tag)}". If it returns more than 20 notes, ask the user to narrow the tag before fanning out. Otherwise call get_note on each of the (capped at 20) results.`
                  : "1. Ask the user which note(s) to scan (cap at 20), then call get_note for each.",
              `2. For each note, parse all unchecked task lines (\`- [ ] …\`).`,
              `3. Group by note (or by section heading where they appear).`,
              `4. Order: blockers, then time-sensitive, then quick wins, then other. Mark items with explicit due dates inline.`,
              "",
              "Output: a markdown checklist the user can paste back into a note. Include the source path next to each item.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "build-moc",
    {
      title: "Build Map of Content",
      description:
        "Generate a Map of Content (MOC) note from a tag or folder: a curated index linking the most important notes with one-line descriptions.",
      argsSchema: {
        tag: z
          .string()
          .max(200)
          .optional()
          .describe("Tag to gather notes from."),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe("Folder to gather notes from."),
      },
    },
    ({ tag, folder }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Build a Map of Content (MOC) for ${tag ? `tag #${escapeControlChars(tag.replace(/^#/, ""))}` : folder ? `folder "${escapeControlChars(folder)}"` : "the requested scope"}.`,
              "",
              "Steps:",
              tag
                ? `1. Call search_by_tag with tag="${escapeControlChars(tag)}".`
                : folder
                  ? `1. Call list_notes with folder="${escapeControlChars(folder)}".`
                  : "1. Ask the user for tag or folder.",
              "2. Cap the candidate set at 40 notes (sample evenly across the result if there are more, or ask the user to narrow scope). For each capped candidate, call get_note with `lines: '1-15'` to keep token usage low.",
              "3. Cluster the notes into 3-7 groups by theme. For each cluster, write a one-line description and 5-15 wikilinks.",
              '4. Surface notes with no obvious cluster as a final "Misc" group.',
              "5. Propose a filename like `MOCs/<topic>.md` and offer to create_note with the assembled content.",
              "",
              "Output format: A complete markdown body with H2 headers per cluster and bulleted wikilinks. Conservative; don't invent links.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
