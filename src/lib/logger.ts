// Minimal leveled logger. Writes to stderr so stdio transport (which uses
// stdout for MCP protocol frames) is never polluted. Supports two modes:
//   - `text`  (default): `[obsidian-mcp-pro] <level> <message>` lines
//   - `json`:            one JSON object per line — operator-aggregatable
//
// Level + mode are resolved once from env at module load (`LOG_LEVEL`,
// `LOG_FORMAT`). Tests can override via `configureLogger`.

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

export function configureLogger(opts: { level?: LogLevel; format?: LogFormat }): void {
  if (opts.level) currentLevel = opts.level;
  if (opts.format) currentFormat = opts.format;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
  if (currentFormat === "json") {
    // Single-line JSON; safe for log shippers (Datadog, Loki, Vector) that
    // split on `\n`. `serializeError` unwraps Error objects so stack traces
    // are preserved without triggering `JSON.stringify`'s "[object Object]".
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...serializeFields(fields),
    };
    process.stderr.write(JSON.stringify(payload) + "\n");
    return;
  }
  const prefix = `[obsidian-mcp-pro]`;
  const suffix = fields && Object.keys(fields).length > 0
    ? " " + formatFieldsText(fields)
    : "";
  process.stderr.write(`${prefix} ${level} ${msg}${suffix}\n`);
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
