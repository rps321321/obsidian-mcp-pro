# Move link behavior

`move_note` with `updateLinks=true` plans changes before moving the file, using the original note locations to resolve links. Valid dot segments in the supplied source and destination paths are normalized before matching note identities.

The plan covers incoming references in other notes and Canvas files. It also covers links inside the moved note. Explicit self-links follow the new path. A basename self-link stays unchanged when it still resolves to the moved note. Other outgoing wikilinks keep their original note targets even when moving changes the nearest match among duplicate basenames. Fragments, aliases, and embed prefixes are preserved.

Markdown paths starting with `./` or `../` are relative to the containing note. Moving that note rebases those paths, including attachment paths and extensionless note paths. Explicit relative note paths match their normalized location and do not fall back to an unrelated note with the same basename. Other Markdown note paths retain the existing vault-path and basename resolution rules.

Rebased explicit relative paths keep a `./` or `../` prefix, including dot-prefixed filenames. If a parent-relative target becomes a sibling, the link uses `./target.md`. This keeps later moves from interpreting that link as a vault-root path when the same filename exists at the root.

Existing non-Markdown files take precedence over identically named note aliases. For those files, the planner checks a readable vault-root path first, then a readable path relative to the source note. A relative attachment target is rebased; a vault-root target stays unchanged. The planner checks file metadata and does not read attachment content.

External URLs, root-absolute URLs, fragment-only links, and code spans are left unchanged. `updateLinks=false` moves the file without scanning or changing links.

After the move, the plan applies edits against the current file contents. `updatedReferrers` includes the destination path when the moved note's own links changed. A failed rewrite appears in `failedReferrers` at the file's current path. The move remains committed after a partial failure; inspect the listed files before retrying. An empty failure list does not validate links that were already unresolved before the move or paths the planner could not read.

Run `npm test -- src/__tests__/moved-note-link-targets.test.ts src/__tests__/link-rewriter.test.ts` for target-resolution, attachment, and partial-failure regressions.
