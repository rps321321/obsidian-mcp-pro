import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { openVaultFileForRead } from "../../lib/vault.js";
import {
  detectMimeType,
  categorizeMimeType,
  getBlockedExtension,
  verifyImageMagicBytes,
} from "../../lib/mime.js";
import { sanitizeError } from "../../lib/errors.js";
import {
  formatUntrustedVaultContent,
  untrustedVaultContentMeta,
} from "../../lib/tool-output.js";
import { log } from "../../lib/logger.js";
import {
  errorResult,
  displayAttachmentValue,
  vaultResourceUri,
  safeResourceMimeType,
} from "./shared.js";

const DEFAULT_GET_ATTACHMENT_LIMIT = 5 * 1024 * 1024; // 5 MB
const ABSOLUTE_GET_ATTACHMENT_LIMIT = 50 * 1024 * 1024; // 50 MB hard cap

function hiddenAttachmentSegment(relPath: string): string | null {
  const segments = relPath.replace(/\\/g, "/").split("/");
  return segments.find((segment) =>
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    segment.startsWith(".")
  ) ?? null;
}

async function assertNoSymlinkAttachmentPath(
  vaultPath: string,
  fullPath: string,
  relPath: string,
): Promise<void> {
  const vaultRoot = path.resolve(vaultPath);
  const resolvedFullPath = path.resolve(fullPath);
  const relativeFromVault = path.relative(vaultRoot, resolvedFullPath);
  if (relativeFromVault.startsWith("..") || path.isAbsolute(relativeFromVault)) {
    throw new Error("Path traversal via symlink detected");
  }

  let current = vaultRoot;
  for (const segment of relativeFromVault.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to fetch symlink attachment: ${displayAttachmentValue(relPath)}`);
    }
  }
}

export function registerGetAttachment(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "get_attachment",
    {
      title: "Get Attachment",
      description:
        "Read an attachment file and return its bytes to the client. Images come back as `image` content blocks (rendered inline by Claude / Cursor), audio as `audio` blocks, everything else as a base64 `resource` block with a vault:// URI. Caps at 5 MB by default to keep token usage sane; raise via `maxBytes` up to 50 MB. The attachment must be inside the vault — markdown notes (.md), canvases (.canvas), and Bases (.base) are deliberately rejected so callers don't accidentally pull text-format files through this binary path; use get_note / read_canvas / read_base instead.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(500)
          .describe("Vault-relative path to the attachment, e.g. 'assets/diagram.png'."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(ABSOLUTE_GET_ATTACHMENT_LIMIT)
          .optional()
          .describe(`Maximum file size to fetch in bytes (default: ${DEFAULT_GET_ATTACHMENT_LIMIT.toLocaleString()}, hard cap: ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`),
      },
    },
    async ({ path: relPath, maxBytes }) => {
      try {
        const hiddenName = hiddenAttachmentSegment(relPath);
        if (hiddenName) {
          return errorResult(
            `Refusing to fetch hidden attachment "${displayAttachmentValue(relPath)}" via get_attachment.`,
          );
        }

        // Reject text-format files so the wrong tool isn't used on them.
        const lowerPath = relPath.toLowerCase();
        if (lowerPath.endsWith(".md") || lowerPath.endsWith(".canvas") || lowerPath.endsWith(".base")) {
          return errorResult(
            `Refusing to fetch "${displayAttachmentValue(relPath)}" via get_attachment - use get_note / read_canvas / read_base instead.`,
          );
        }

        // SEC-7: Block dangerous executable extensions.
        const blockedExt = getBlockedExtension(relPath);
        if (blockedExt) {
          return errorResult(
            `Blocked: "${displayAttachmentValue(relPath)}" has a dangerous extension (${displayAttachmentValue(blockedExt)}). ` +
            `Executable file types are not served as attachments.`,
          );
        }

        const limit = maxBytes ?? DEFAULT_GET_ATTACHMENT_LIMIT;
        let opened: Awaited<ReturnType<typeof openVaultFileForRead>>;
        try {
          opened = await openVaultFileForRead(vaultPath, relPath);
        } catch (err) {
          if ((err as Error).message === `Not a regular file: ${relPath}`) {
            return errorResult(
              `Attachment "${displayAttachmentValue(relPath)}" is not a regular file.`,
            );
          }
          throw err;
        }
        const handle = opened.handle;
        let bytes: Buffer;
        try {
          await assertNoSymlinkAttachmentPath(vaultPath, opened.fullPath, relPath);
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return errorResult(
              `Attachment "${displayAttachmentValue(relPath)}" is not a regular file.`,
            );
          }
          if (stat.size > limit) {
            return errorResult(
              `Attachment "${displayAttachmentValue(relPath)}" is ${stat.size.toLocaleString()} bytes - over the ${limit.toLocaleString()}-byte limit. Pass maxBytes to override (hard cap ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`,
            );
          }
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (bytes.byteLength > limit) {
          return errorResult(
            `Attachment "${displayAttachmentValue(relPath)}" is ${bytes.byteLength.toLocaleString()} bytes - over the ${limit.toLocaleString()}-byte limit. Pass maxBytes to override (hard cap ${ABSOLUTE_GET_ATTACHMENT_LIMIT.toLocaleString()}).`,
          );
        }
        const attachmentSize = bytes.byteLength;
        const mime = detectMimeType(relPath);
        const category = categorizeMimeType(mime);
        const basename = path.basename(relPath);
        const displayedBasename = displayAttachmentValue(basename);

        // SEC-8: SVG files can contain embedded <script> tags and event
        // handlers, making them an XSS vector. Return SVG content as
        // plain text instead of as an image embed.
        if (mime === "image/svg+xml") {
          const svgText = bytes.toString("utf-8");
          const trustLabel = "get_attachment text";
          return {
            content: [
              {
                type: "text" as const,
                text: `Attached: ${displayedBasename} (SVG returned as text/plain for security - SVGs may contain embedded scripts)\n` +
                      `Size: ${attachmentSize.toLocaleString()} bytes`,
              },
              {
                type: "resource" as const,
                resource: {
                  uri: vaultResourceUri(relPath),
                  mimeType: "text/plain",
                  text: formatUntrustedVaultContent(trustLabel, svgText),
                  _meta: untrustedVaultContentMeta(trustLabel),
                },
                _meta: untrustedVaultContentMeta(trustLabel),
              },
            ],
          };
        }

        // SEC-9: Best-effort magic-bytes verification for image types.
        // A mismatch means the file extension doesn't match the actual
        // content - warn the caller but still serve the file.
        let magicWarning = "";
        if (category === "image") {
          const magicCheck = verifyImageMagicBytes(mime, bytes);
          if (magicCheck === false) {
            magicWarning =
              ` [WARNING: file header does not match expected ${mime} signature - ` +
              `the extension may be misleading]`;
          }
        }

        const data = bytes.toString("base64");

        // Image / audio content blocks render natively in compatible
        // clients; everything else round-trips as a `resource` block so the
        // client can save it, hand it off to a tool, or display a download
        // affordance.
        if (category === "image") {
          return {
            content: [
              { type: "text" as const, text: `Attached: ${displayedBasename} (${mime}, ${attachmentSize.toLocaleString()} bytes)${magicWarning}` },
              { type: "image" as const, data, mimeType: mime },
            ],
          };
        }
        if (category === "audio") {
          return {
            content: [
              { type: "text" as const, text: `Attached: ${displayedBasename} (${mime}, ${attachmentSize.toLocaleString()} bytes)` },
              { type: "audio" as const, data, mimeType: mime },
            ],
          };
        }
        const resourceMime = safeResourceMimeType(mime);
        const mimeLabel = resourceMime === mime ? mime : `${mime} returned as ${resourceMime}`;
        return {
          content: [
            { type: "text" as const, text: `Attached: ${displayedBasename} (${mimeLabel}, ${attachmentSize.toLocaleString()} bytes)` },
            {
              type: "resource" as const,
              resource: {
                // vault:// URI lets clients distinguish vault files from
                // arbitrary URLs in their UI without leaking the host path.
                uri: vaultResourceUri(relPath),
                mimeType: resourceMime,
                blob: data,
              },
            },
          ],
        };
      } catch (err) {
        log.error("get_attachment failed", { tool: "get_attachment", err: err as Error });
        return errorResult(`Error reading attachment: ${sanitizeError(err)}`);
      }
    },
  );
}
