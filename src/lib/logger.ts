// Minimal leveled logger. Writes to stderr so stdio transport (which uses
// stdout for MCP protocol frames) is never polluted. Supports two modes:
//   - `text`  (default): `[obsidian-mcp-pro] <level> <message>` lines
//   - `json`:            one JSON object per line — operator-aggregatable
//
// Level + mode are resolved once from env at module load (`LOG_LEVEL`,
// `LOG_FORMAT`). Tests can override via `configureLogger`.
//
// Local stderr is redacted before write, so paths, secret-bearing URLs, and
// control characters do not leak into shared terminal/session logs.
//
// When an `McpServer` is wired in via `configureLogger({ mcpServer })` the
// logger ALSO forwards each message to the connected MCP client(s) via
// `notifications/message`. The MCP Server declares a `logging` capability
// (see index.ts) so clients can filter by level at runtime via
// `logging/setLevel`. Forwarding is best-effort: if the transport is not
// connected (or the send rejects for any reason) the error is swallowed so
// logging never becomes a failure mode of the server.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stripPaths, escapeControlChars, redactUrlSecrets } from "./errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";
type VaultPathRedactionMode = "field" | "message";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (!raw) return fallback;
  const norm = raw.toLowerCase();
  if (norm in LEVEL_RANK) return norm as LogLevel;
  return fallback;
}

function parseFormat(raw: string | undefined): LogFormat {
  return raw?.toLowerCase() === "json" ? "json" : "text";
}

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL, "info");
let currentFormat: LogFormat = parseFormat(process.env.LOG_FORMAT);
let mcpServer: McpServer | undefined;

// Internal levels map to RFC 5424 syslog levels on the wire (what the MCP spec
// uses for `logging/setLevel` and `notifications/message`). `warn` renames to
// `warning` — MCP has no `silent`, which is handled by the local filter before
// we get here.
const MCP_LEVEL: Record<Exclude<LogLevel, "silent">, "debug" | "info" | "warning" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

const VAULT_PATH_FIELD_KEYS = new Set([
  "configpath",
  "currentroot",
  "file",
  "files",
  "fullpath",
  "note",
  "notepath",
  "notes",
  "path",
  "paths",
  "relativepath",
  "relpath",
  "snapshotroot",
  "vault",
  "vaultpath",
]);
const VAULT_PATH_FIELD_TOKENS = new Set([
  "file",
  "files",
  "note",
  "notes",
  "path",
  "paths",
  "root",
  "roots",
]);

const VAULT_PATH_EXTENSIONS = new Set([
  ".avif",
  ".base",
  ".canvas",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".md",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".svg",
  ".wav",
  ".webm",
  ".webp",
]);

export function configureLogger(opts: {
  level?: LogLevel;
  format?: LogFormat;
  /** Pass an `McpServer` to forward log messages to connected clients via
   *  `notifications/message`. Pass `null` to disable forwarding. `undefined`
   *  leaves the current binding in place (tests use this to tweak level/format
   *  without touching MCP wiring). */
  mcpServer?: McpServer | null;
}): void {
  if (opts.level) currentLevel = opts.level;
  if (opts.format) currentFormat = opts.format;
  if (opts.mcpServer !== undefined) mcpServer = opts.mcpServer ?? undefined;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;

  const serialized = serializeFields(fields);

  if (currentFormat === "json") {
    // Single-line JSON; safe for log shippers (Datadog, Loki, Vector) that
    // split on `\n`. `serializeFields` unwraps Error objects so stack traces
    // are preserved without triggering `JSON.stringify`'s "[object Object]".
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: sanitizeLogString(msg),
      ...sanitizeLogData(serialized),
    };
    process.stderr.write(JSON.stringify(payload) + "\n");
  } else {
    const prefix = `[obsidian-mcp-pro]`;
    const suffix = fields && Object.keys(fields).length > 0
      ? " " + formatFieldsText(fields)
      : "";
    process.stderr.write(`${prefix} ${level} ${sanitizeLogString(msg)}${suffix}\n`);
  }

  // Forward to the MCP client too when a server is wired in. Fire-and-forget:
  // we must not await here (would serialize request handling) and we must not
  // throw (logging errors should never take down a tool call). The SDK drops
  // messages below the session's `logging/setLevel` on its own.
  //
  // The MCP `data` payload goes verbatim to the client in `notifications/
  // message` — no SDK sanitization. Scrub paths and secret-bearing URLs out of
  // string values so remote clients never see the operator's host filesystem
  // layout or vault note names from structured path fields.
  if (mcpServer && level !== "silent") {
    const mcpLevel = MCP_LEVEL[level];
    const data: Record<string, unknown> = { msg: sanitizeLogString(msg) };
    if (fields && Object.keys(fields).length > 0) {
      Object.assign(data, sanitizeLogData(serialized));
    }
    mcpServer.server
      .sendLoggingMessage({ level: mcpLevel, logger: "obsidian-mcp-pro", data })
      .catch(() => undefined);
  }
}

// Recursively strip absolute paths and escape control characters from log
// payload values before forwarding to an MCP client. Applies to strings and
// to the `.message`/`.stack` of already-serialized Error objects (where stack
// traces embed host paths). Non-string leaf values pass through unchanged.
function sanitizeLogData(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = sanitizeValue(k, v);
  }
  return out;
}

function sanitizeLogString(
  value: string,
  redactVaultPaths?: VaultPathRedactionMode,
): string {
  const stripped = stripPaths(redactUrlSecrets(value));
  return escapeControlChars(
    redactVaultPaths ? redactVaultPathText(stripped, redactVaultPaths) : stripped,
  );
}

function isVaultPathField(key: string): boolean {
  const lower = key.toLowerCase();
  if (VAULT_PATH_FIELD_KEYS.has(lower)) return true;
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = tokens.at(-1);
  return last !== undefined && VAULT_PATH_FIELD_TOKENS.has(last);
}

// Returns true when a string looks like a vault-relative file path: it contains
// a path separator, or ends with one of the extensions Obsidian files can carry.
// Trade-off: bare note names without an extension or slash (e.g. "therapy") are
// not considered vault paths and will be forwarded as-is to MCP clients.
function looksLikeVaultPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  return containsVaultPathExtension(trimmed);
}

function containsVaultPathExtension(value: string): boolean {
  const lower = value.toLowerCase();
  return [...VAULT_PATH_EXTENSIONS].some((ext) =>
    lower.endsWith(ext) ||
    lower.includes(`${ext}:`) ||
    lower.includes(`${ext}/`) ||
    lower.includes(`${ext}\\`),
  );
}

function looksLikeVaultPathMessageToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("<path>") || trimmed.includes("<redacted-url>")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/?$/.test(trimmed)) return false;
  return containsVaultPathExtension(trimmed);
}

function redactVaultPathText(value: string, mode: VaultPathRedactionMode): string {
  return value.replace(/[^\s"'`<>(){}[\],;]+/g, (token) => {
    const trailing = token.match(/[.:!?]+$/)?.[0] ?? "";
    const core = trailing ? token.slice(0, -trailing.length) : token;
    const shouldRedact = mode === "field"
      ? looksLikeVaultPath(core)
      : looksLikeVaultPathMessageToken(core);
    return shouldRedact ? `<vault path>${trailing}` : token;
  });
}

function isSerializedErrorObject(obj: Record<string, unknown>): boolean {
  return typeof obj.message === "string" &&
    (typeof obj.name === "string" || typeof obj.stack === "string");
}

function sanitizeValue(
  key: string,
  v: unknown,
  redactVaultPath?: VaultPathRedactionMode,
): unknown {
  const redactionMode = redactVaultPath ?? (isVaultPathField(key) ? "field" : undefined);
  if (typeof v === "string") {
    const stripped = stripPaths(redactUrlSecrets(v));
    const redacted = redactionMode
      ? redactVaultPathText(stripped, redactionMode)
      : stripped;
    return escapeControlChars(redacted);
  }
  if (Array.isArray(v)) {
    return v.map((inner) => sanitizeValue(key, inner, redactionMode));
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const childRedactVaultPath = redactionMode ??
      (isSerializedErrorObject(obj) ? "message" : undefined);
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(obj)) {
      out[k] = sanitizeValue(k, inner, childRedactVaultPath);
    }
    return out;
  }
  return v;
}

function serializeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error
      ? { name: v.name, message: v.message, stack: v.stack }
      : v;
  }
  return out;
}

function formatFieldsText(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      parts.push(`${k}=${sanitizeLogString(v.message, "message")}`);
    } else if (typeof v === "string") {
      const sanitized = sanitizeValue(k, v);
      parts.push(`${k}=${typeof sanitized === "string" ? sanitized : String(sanitized)}`);
    } else {
      const sanitized = sanitizeValue(k, v);
      parts.push(`${k}=${escapeControlChars(JSON.stringify(sanitized) ?? String(sanitized))}`);
    }
  }
  return parts.join(" ");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
