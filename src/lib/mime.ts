/**
 * Minimal extension → MIME map for the file types Obsidian users actually
 * paste into vaults. Covers images, audio, video, PDF, and plaintext-ish
 * formats. Anything unknown falls back to `application/octet-stream` and
 * gets returned as a binary blob — clients can still render or save it,
 * they just won't get a content-type-aware preview.
 *
 * Deliberately small: a 200-entry mime DB is overkill when 95% of vault
 * attachments are PNG/JPG/PDF/MP4. Add entries when users hit them.
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
