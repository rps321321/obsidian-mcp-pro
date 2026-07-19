/**
 * The tool seam: one deep module every MCP tool is registered through.
 *
 * Before this module, all 41 tools re-implemented the same recipe inline: a
 * terminal `try/catch` that logged and sanitized thrown errors, plus manual
 * `formatUntrustedVaultContent` / `untrustedVaultContentMeta` wrapping of every
 * piece of vault-derived text. Two security concerns (error-response
 * sanitization and untrusted-content trust-wrapping) were smeared across ~45
 * call sites with no single place enforcing them.
 *
 * `defineTool` collapses that recipe into one place. A handler becomes schema
 * plus pure logic that returns a `ToolResult` (built only via the constructors
 * below) or throws. The seam owns:
 *   - registration (the tool's title/description/annotations/inputSchema pass
 *     through untouched, preserving the per-tool surface third-party scorers
 *     grade),
 *   - context assembly (`ctx = { vaultPath, server, extra }`),
 *   - the terminal error boundary (log + `sanitizeError` on anything thrown),
 *   - result rendering and untrusted-content wrapping.
 *
 * `ToolResult` is a branded type: a raw `{ content: [...] }` literal does not
 * satisfy it, so the ONLY way to surface model-readable vault text is through
 * `untrustedText` / `richText(...).untrusted(...)`, which wrap it by
 * construction. See `docs/adr/0001-tool-seam.md` for the decision record.
 *
 * The rendering primitives (`formatUntrustedVaultContent`,
 * `untrustedVaultContentMeta`, `indentBlock`) still live in `tool-output.ts`;
 * this seam is now their sole caller from the tool layer.
 */

import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { sanitizeError } from "./errors.js";
import {
  formatUntrustedVaultContent,
  indentBlock,
  untrustedVaultContentMeta,
} from "./tool-output.js";
import { log } from "./logger.js";

/** The request-scoped SDK context handed to every tool handler. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Everything a handler may reach for beyond its validated `args`. Assembled
 * once by the seam. Most read handlers use only `vaultPath`; elicitation tools
 * reach `server`; progress-reporting tools reach `extra`.
 */
export interface ToolCtx {
  vaultPath: string;
  server: McpServer;
  extra: ToolExtra;
}

// A branded MCP result. The brand is phantom (compile-time only) so a raw
// object literal won't satisfy `ToolResult` — handlers must go through the
// constructors below, which is what makes trust-wrapping unforgettable.
declare const toolResultBrand: unique symbol;
export type ToolResult = CallToolResult & { readonly [toolResultBrand]: true };

function seal(result: CallToolResult): ToolResult {
  return result as ToolResult;
}

/** A single trusted text block: server-authored text, never wrapped. */
export function text(body: string): ToolResult {
  return seal({ content: [{ type: "text", text: body }] });
}

/**
 * A single block that is entirely untrusted vault-derived text. Wraps the body
 * in BEGIN/END markers and attaches the trust `_meta` tag under `label`.
 */
export function untrustedText(label: string, body: string): ToolResult {
  return seal({
    content: [
      {
        type: "text",
        text: formatUntrustedVaultContent(label, body),
        _meta: untrustedVaultContentMeta(label),
      },
    ],
  });
}

/** A single error block carrying a server-authored message verbatim. */
export function error(message: string): ToolResult {
  return seal({ content: [{ type: "text", text: message }], isError: true });
}

/** Flag an already-built result as an error (e.g. a `richText` that carries an
 *  untrusted path in its error message). */
export function asError(result: ToolResult): ToolResult {
  return seal({ ...(result as CallToolResult), isError: true });
}

// Non-text media results. `get_attachment` is the only multi-type tool: it
// returns a server-authored caption text block followed by exactly one media
// block. Raw base64 bytes (`image`/`audio`/`blobResource`) are NOT model-readable
// text, so there is no injection surface and they carry no trust `_meta` — only
// `untrustedResource`, which surfaces model-readable text, wraps and tags. The
// block taxonomy is closed; see docs/adr/0001-tool-seam.md.

/** A caption text block plus an `image` content block carrying raw base64 bytes. */
export function image(
  caption: string,
  data: string,
  mimeType: string
): ToolResult {
  return seal({
    content: [
      { type: "text", text: caption },
      { type: "image", data, mimeType },
    ],
  });
}

/** A caption text block plus an `audio` content block carrying raw base64 bytes. */
export function audio(
  caption: string,
  data: string,
  mimeType: string
): ToolResult {
  return seal({
    content: [
      { type: "text", text: caption },
      { type: "audio", data, mimeType },
    ],
  });
}

/**
 * A caption text block plus a `resource` block carrying raw base64 `blob` bytes
 * under a `vault://` URI. Like image/audio, blobs are not model-readable text
 * and carry no trust `_meta`.
 */
export function blobResource(
  caption: string,
  uri: string,
  mimeType: string,
  blob: string
): ToolResult {
  return seal({
    content: [
      { type: "text", text: caption },
      { type: "resource", resource: { uri, mimeType, blob } },
    ],
  });
}

/**
 * A caption text block plus a `resource` block carrying model-readable *text*
 * (e.g. an SVG served as text/plain for XSS safety). The only non-text
 * constructor that wraps: the resource text is BEGIN/END-wrapped and the trust
 * `_meta` is attached at BOTH the resource and the block level, so a client that
 * surfaces either layer still sees the untrusted tag.
 */
export function untrustedResource(
  caption: string,
  label: string,
  uri: string,
  mimeType: string,
  body: string
): ToolResult {
  return seal({
    content: [
      { type: "text", text: caption },
      {
        type: "resource",
        resource: {
          uri,
          mimeType,
          text: formatUntrustedVaultContent(label, body),
          _meta: untrustedVaultContentMeta(label),
        },
        _meta: untrustedVaultContentMeta(label),
      },
    ],
  });
}

/**
 * Builder for a single text block that interleaves server-authored framing with
 * inline untrusted vault-content sections. `trusted` appends framing verbatim;
 * `untrusted` appends a BEGIN/END-wrapped (optionally indented) section and
 * marks the block as carrying untrusted content. Segments join with "\n", the
 * same way handlers used to `lines.join("\n")`.
 */
export interface RichTextBuilder {
  /** Append a server-authored line verbatim. Naming it `trusted` makes any
   *  attempt to pass vault text here read wrong at review time. */
  trusted(line: string): void;
  /** Append an untrusted vault-content section, wrapped and optionally indented. */
  untrusted(label: string, body: string, indent?: string): void;
}

/**
 * Compose a mixed text block. `itemTrustLabel` names the block-level trust tag,
 * which is attached only if at least one `untrusted` section was appended — so
 * an all-trusted result (e.g. an empty-result message) carries no `_meta`,
 * matching the prior per-handler behaviour.
 */
export function richText(
  itemTrustLabel: string,
  build: (b: RichTextBuilder) => void
): ToolResult {
  const pieces: string[] = [];
  let hasUntrusted = false;
  build({
    trusted(line) {
      pieces.push(line);
    },
    untrusted(label, body, indent = "") {
      pieces.push(
        indentBlock(formatUntrustedVaultContent(label, body), indent)
      );
      hasUntrusted = true;
    },
  });
  const item: CallToolResult["content"][number] = {
    type: "text",
    text: pieces.join("\n"),
    ...(hasUntrusted
      ? { _meta: untrustedVaultContentMeta(itemTrustLabel) }
      : {}),
  };
  return seal({ content: [item] });
}

/** The static configuration half of a tool: everything the MCP client sees. */
export interface ToolSpec<InputArgs extends ZodRawShapeCompat> {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: InputArgs;
}

/**
 * Register a tool through the seam. The handler receives its validated `args`
 * (type inferred from `inputSchema`, exactly as the SDK infers it) and `ctx`,
 * and returns a `ToolResult` or throws. Anything thrown is logged as
 * `"<name> failed"` and returned as a sanitized `isError` result — the single
 * place error sanitization is now enforced.
 */
export function defineTool<InputArgs extends ZodRawShapeCompat>(
  server: McpServer,
  vaultPath: string,
  spec: ToolSpec<InputArgs>,
  handler: (
    args: ShapeOutput<InputArgs>,
    ctx: ToolCtx
  ) => ToolResult | Promise<ToolResult>
): void {
  const cb = async (
    args: ShapeOutput<InputArgs>,
    extra: ToolExtra
  ): Promise<ToolResult> => {
    try {
      return await handler(args, { vaultPath, server, extra });
    } catch (err) {
      log.error(`${spec.name} failed`, { tool: spec.name, err: err as Error });
      return error(`Error: ${sanitizeError(err)}`);
    }
  };
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      annotations: spec.annotations,
      inputSchema: spec.inputSchema,
    },
    // `ToolCallback<InputArgs>` is an unreduced conditional over the generic
    // shape, so a structurally-matching callback (args typed as the SDK's own
    // `ShapeOutput<InputArgs>`, returning a `CallToolResult`) can't be assigned
    // to it directly. The shape is matched deliberately; cast at this single
    // boundary.
    cb as unknown as ToolCallback<InputArgs>
  );
}
