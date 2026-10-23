# Note update conflicts

`updateNote`, `appendToNote`, and `prependToNote` serialize cooperating callers through a per-file lock in this process. Tools that use `updateNote`, including frontmatter, section, block, replacement, and tag edits, share its conflict check.

Before a mutation replaces a note, it compares the current file with the original snapshot. The comparison checks file identity, size, modification and change times, and exact bytes. It runs after the candidate content is staged and before every rename attempt, including Windows retries. The comparison reads at most the original byte count plus one.

If the check observes a changed or deleted file, the mutation rejects the update. It removes its staged file and leaves the current note untouched. A deleted note stays deleted. MCP callers receive an `isError` result with this message:

```text
Note changed during this update. No changes were written. Read the current note and retry.
```

Read the current version before deciding whether to repeat the operation. The server does not automatically rerun a transform or merge conflicting content. Error messages and logs do not contain either version's note text. The conflict path creates no persistent backup or recovery copy because the competing version remains at its existing path.

An unchanged transform performs no write. It leaves an intervening external edit untouched and does not need a conflict error.

## Limits

This is optimistic conflict detection, not atomic compare-and-swap. The filesystem check and rename are separate operations. An editor or sync client that does not participate in this process's lock can still write between the last check and the rename, or overwrite the result afterward. File metadata can also have limited precision. These checks do not provide a transaction with Obsidian or another process.

Atomic replacement still keeps the target present for readers and prevents a partially staged payload from replacing it. The implementation does not detach the original note while it checks for a conflict.

The conflict check covers note transforms, appends, and prepends. An explicit `writeNote` replacement, Canvas mutation, or move/delete link-rewrite transaction does not acquire this expected-version policy merely by using the shared atomic-write primitive. Those operations retain their existing checks and limits.

## Verification

Run `npm test -- src/__tests__/note-update-conflicts.test.ts src/__tests__/vault.test.ts`. The cases include a separate Node process that writes while an asynchronous transform is paused, edits during staging, replacement identity, deletion, MCP errors, and the existing same-process mutation tests. The rename-retry case runs on Windows.
