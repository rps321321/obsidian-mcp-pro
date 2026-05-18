/**
 * Minimal extension → MIME map for the file types Obsidian users actually
 * paste into vaults. Covers images, audio, video, PDF, and plaintext-ish
 * formats. Anything unknown falls back to `application/octet-stream` and
 * gets returned as a binary blob - clients can still render or save it,
 * they just won't get a content-type-aware preview.
 *
 * Deliberately small: a 200-entry mime DB is overkill when 95% of vault
 * attachments are PNG/JPG/PDF/MP4. Add entries when users hit them.
 *
 * SEC-9 LIMITATION: MIME detection is extension-only, which means a file
 * renamed from `malware.exe` to `malware.png` would be classified as
 * `image/png`. A full solution would read file magic bytes (signatures)
 * at the start of each file. We do a best-effort magic-bytes check for
 * the most common image formats via `verifyImageMagicBytes` below, but
 * callers should not rely on this for security-critical decisions where
 * the file source is untrusted.
 */

const MIME_BY_EXT: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".heic": "image/heic",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  // Documents
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  // Plaintext-adjacent
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  // Archives — treated as opaque blobs
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

export type MediaCategory = "image" | "audio" | "blob";

export function detectMimeType(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = relativePath.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Pick the right MCP content-block shape for a given MIME type. The MCP
 * protocol has dedicated `image` and `audio` block types that clients can
 * render natively; everything else round-trips as base64 in a `resource`
 * block so clients can download or hand it off.
 */
export function categorizeMimeType(mime: string): MediaCategory {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "blob";
}

/* ------------------------------------------------------------------ */
/*  SEC-7: Blocked extensions - dangerous file types that should       */
/*  never be served or processed as vault attachments.                 */
/* ------------------------------------------------------------------ */

/** Extensions that are never safe to process as attachments. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".scr",
  ".pif",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".ps1",
]);

/** Returns the blocked extension if the path has one, or `null` if safe. */
export function getBlockedExtension(relativePath: string): string | null {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = relativePath.slice(dot).toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext) ? ext : null;
}

/* ------------------------------------------------------------------ */
/*  SEC-9: Best-effort magic-bytes check for common image formats.     */
/*  Returns true if the leading bytes match the expected signature     */
/*  for the MIME type, false if they don't match, or null if we have   */
/*  no signature to check against (unsupported format).                */
/* ------------------------------------------------------------------ */

const IMAGE_SIGNATURES: ReadonlyArray<{
  mime: string;
  /** Byte prefix the file must start with. */
  magic: Buffer;
}> = [
  { mime: "image/png",  magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },        // \x89PNG
  { mime: "image/jpeg", magic: Buffer.from([0xff, 0xd8, 0xff]) },              // \xFF\xD8\xFF
  { mime: "image/gif",  magic: Buffer.from([0x47, 0x49, 0x46, 0x38]) },        // GIF8
  { mime: "image/webp", magic: Buffer.from([0x52, 0x49, 0x46, 0x46]) },        // RIFF
  { mime: "image/bmp",  magic: Buffer.from([0x42, 0x4d]) },                    // BM
];

/**
 * Best-effort check: do the first bytes of `data` match the expected
 * magic signature for `mime`?
 *
 * Returns `true` (matches), `false` (mismatch), or `null` (no
 * signature known for this MIME type - cannot verify).
 */
export function verifyImageMagicBytes(
  mime: string,
  data: Buffer,
): boolean | null {
  const sig = IMAGE_SIGNATURES.find((s) => s.mime === mime);
  if (!sig) return null; // no signature to check against
  if (data.length < sig.magic.length) return false;
  return data.subarray(0, sig.magic.length).equals(sig.magic);
}
