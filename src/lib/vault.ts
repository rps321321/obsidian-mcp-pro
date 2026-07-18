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
