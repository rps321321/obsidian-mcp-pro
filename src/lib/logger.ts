// Minimal leveled logger. Writes to stderr so stdio transport (which uses
// stdout for MCP protocol frames) is never polluted. Supports two modes:
//   - `text`  (default): `[obsidian-mcp-pro] <level> <message>` lines
//   - `json`:            one JSON object per line — operator-aggregatable
//
// Level + mode are resolved once from env at module load (`LOG_LEVEL`,
// `LOG_FORMAT`). Tests can override via `configureLogger`.
//
// When an `McpServer` is wired in via `configureLogger({ mcpServer })` the
// logger ALSO forwards each message to the connected MCP client(s) via
// `notifications/message`. The MCP Server declares a `logging` capability
// (see index.ts) so clients can filter by level at runtime via
// `logging/setLevel`. Forwarding is best-effort: if the transport is not
// connected (or the send rejects for any reason) the error is swallowed so
// logging never becomes a failure mode of the server.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";

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
      msg,
      ...serialized,
    };
    process.stderr.write(JSON.stringify(payload) + "\n");
  } else {
    const prefix = `[obsidian-mcp-pro]`;
    const suffix = fields && Object.keys(fields).length > 0
      ? " " + formatFieldsText(fields)
      : "";
    process.stderr.write(`${prefix} ${level} ${msg}${suffix}\n`);
  }

  // Forward to the MCP client too when a server is wired in. Fire-and-forget:
  // we must not await here (would serialize request handling) and we must not
  // throw (logging errors should never take down a tool call). The SDK drops
  // messages below the session's `logging/setLevel` on its own.
  if (mcpServer && level !== "silent") {
    const mcpLevel = MCP_LEVEL[level];
    const data: Record<string, unknown> = { msg };
    if (fields && Object.keys(fields).length > 0) {
      Object.assign(data, serialized);
    }
    mcpServer.server
      .sendLoggingMessage({ level: mcpLevel, logger: "obsidian-mcp-pro", data })
      .catch(() => undefined);
  }
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
      parts.push(`${k}=${v.message}`);
    } else if (typeof v === "string") {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`);
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
