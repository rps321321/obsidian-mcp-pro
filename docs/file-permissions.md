# File permissions during atomic replacement

On POSIX filesystems, `atomicWriteFile` retains an existing target's permission and special mode bits. Guarded note updates use the mode from their original file snapshot. Other atomic replacements inspect the existing target before staging.

The staging file starts with the intended mode intersected with `0600`, further restricted by the process umask. It therefore has no group or other access while content is written. After the write completes, the staging file receives the intended final mode before rename. The original file is never chmodded, so staging does not alter the target's ctime or invalidate its conflict snapshot.

For new files, the policy remains `0666 & ~umask`. `writeNote` with exclusive creation first reserves the note with `fs.open(..., "wx")`, which uses that creation policy. Atomic replacement retains the placeholder's mode. Direct atomic creation of a missing target applies the same policy explicitly. Under umask `022`, a new note is `0644`; under `077`, it is `0600`.

If staging, mode adjustment, or replacement fails, temporary-file cleanup runs and the failed replacement does not overwrite the target. Existing conflict detection still rejects observed external edits or permission changes before rename. It remains optimistic rather than atomic compare-and-swap.

This policy preserves POSIX mode bits. It does not preserve ownership, ACLs, or extended attributes. Windows keeps the existing platform behavior without a POSIX-mode or ACL-preservation guarantee.

The Node 24 documentation describes [file creation modes](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesopenpath-flags-mode), [chmod](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseschmodpath-mode), and [the process umask](https://nodejs.org/docs/latest-v24.x/api/process.html#processumaskmask).

Run the regressions on a POSIX filesystem with:

```sh
npm test -- src/__tests__/atomic-write-permissions.test.ts src/__tests__/note-update-conflicts.test.ts
```

The permission suite checks actual filesystem mode support and skips on Windows. Its temporary fixtures must live on a POSIX filesystem, rather than a Windows bind mount, to establish POSIX behavior.
