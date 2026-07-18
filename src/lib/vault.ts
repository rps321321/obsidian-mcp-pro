/**
 * Compatibility barrel for the decomposed vault layer. Contains no logic:
 * every symbol lives in one of the layered modules below and is re-exported
 * here so existing `./vault.js` import sites keep working unchanged.
 *
 * Module map (each depends only on layers above it):
 *   vault-fs      path safety · locking · atomic writes · byte guards · traversal
 *   note-reads    readNote · readNoteLineRange · listNotes
 *   canvas        list/read/write/update canvas files
 *   bases         Base filter engine + list/read base files
 *   link-rewriter plan/apply move + delete link rewrites
 *   note-ops      write/update/append/prepend/delete/move mutations
 *   vault-search  searchInContents / searchNotes
 *   vault-stats   getNoteStats / listAttachments / getAttachmentStats
 *
 * New code should import from the specific module, not this barrel.
 */

// Re-export foundation primitives so external call sites keep importing from vault.js.
export {
  resolveVaultPathSafe,
  readVaultTextFile,
  atomicWriteFile,
  withFileLock,
  vaultRewriteLockKey,
  resolveVaultPath,
  resolveVaultInternalPathSafe,
  getVaultRootRealPath,
  openVaultFileForRead,
  openVaultInternalFileForRead,
  assertNoteFileSize,
  setMaxNoteFileBytesForTests,
  setMaxNoteLineRangeBytesForTests,
  type ValidatedVaultFile,
} from "./vault-fs.js";

// Re-export note-read APIs so external call sites keep importing from vault.js.
export {
  readNote,
  readNoteLineRange,
  listNotes,
  type NoteLineRangeRead,
} from "./note-reads.js";

// Re-export canvas + bases file-type APIs so external call sites keep
// importing from vault.js.
export {
  listCanvasFiles,
  readCanvasFile,
  writeCanvasFile,
  updateCanvasFile,
  MAX_CANVAS_FILE_BYTES,
} from "./canvas.js";
export { listBaseFiles, readBaseFile } from "./bases.js";

// Re-export search + stats query APIs so external call sites keep importing
// from vault.js.
export { searchInContents, searchNotes } from "./vault-search.js";
export {
  getNoteStats,
  listAttachments,
  getAttachmentStats,
} from "./vault-stats.js";

// Re-export note mutation APIs so external call sites keep importing from
// vault.js.
export {
  writeNote,
  updateNote,
  appendToNote,
  prependToNote,
  deleteNote,
  moveNote,
  type DeleteNoteOptions,
  type DeleteNoteResult,
  type MoveNoteOptions,
  type MoveNoteResult,
} from "./note-ops.js";
