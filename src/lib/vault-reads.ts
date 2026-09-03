/**
 * Canonical vault-read seam.
 *
 * Point reads stay direct and always-fresh via `note-reads`. Vault-wide batch
 * reads use the mtime cache via `index-cache`. Keeping both APIs reachable
 * from one seam makes the semantic distinction explicit without making the
 * pure single-note reader stateful.
 */
export {
  assertMarkdownNotePath,
  listNotes,
  readNote,
  readNoteLineRange,
  type NoteLineRangeRead,
} from "./note-reads.js";

export {
  readAllCached,
  type CachedFileStats,
  type ReadAllResult,
} from "./index-cache.js";
