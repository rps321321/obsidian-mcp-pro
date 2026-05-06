import yaml from "js-yaml";
import { parseFrontmatter, extractTags } from "./markdown.js";

/**
 * Minimal Obsidian Bases (`.base` file) support.
 *
 * A Bases file is YAML describing filters, properties, and view definitions
 * over the vault's notes. Real Obsidian implements a richer DSL than we
 * support here — this module covers the subset that's reliably useful for
 * an MCP-driven query path:
 *
 *   filters:
 *     and:                    # also: or, not, root-level array (= and)
 *       - taggedWith(file, "project")
 *       - file.hasTag("active")
 *       - status == "in-progress"
 *       - priority != "low"
 *       - file.name contains "2026"
 *
 * Unsupported filter expressions are surfaced as parse warnings and treated
 * as `true` (i.e. permissive) so a partial Base still returns plausible
 * rows. Callers can inspect `warnings` to see which clauses were skipped.
 */

export interface BaseDocument {
  filters?: BaseFilter | BaseFilter[];
  properties?: Record<string, BasePropertySpec>;
  views?: BaseView[];
  /** Catch-all for fields we don't model. */
  [key: string]: unknown;
}

export interface BasePropertySpec {
  displayName?: string;
  [key: string]: unknown;
}

export interface BaseView {
  type: string;
  name?: string;
  filters?: BaseFilter | BaseFilter[];
  order?: string[];
  [key: string]: unknown;
}

export type BaseFilter =
  | string
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter };

export interface ParsedBase {
  doc: BaseDocument;
  warnings: string[];
}

export function parseBaseFile(raw: string): ParsedBase {
  const warnings: string[] = [];
  let doc: BaseDocument = {};
  try {
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as BaseDocument;
    } else {
      warnings.push("Top-level YAML is not an object; treating as empty Base.");
    }
  } catch (err) {
    warnings.push(`YAML parse error: ${(err as Error).message}`);
  }
  return { doc, warnings };
}

/** A single row in a query result: a note path plus its frontmatter and tags. */
export interface BaseRow {
  path: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}

export interface QueryResult {
  rows: BaseRow[];
  warnings: string[];
}

/**
 * Build a row for a single note. Pre-parsing once per note keeps the filter
 * evaluator fast across large vaults.
 */
export function buildRow(path: string, content: string): BaseRow {
  const { data } = parseFrontmatter(content);
  return {
    path,
    frontmatter: data,
    tags: extractTags(content),
  };
}

interface EvaluationContext {
  warnings: string[];
}

/** Recursion-depth limit for the filter evaluator. A pathological `.base`
 *  file with deeply nested `not`/`and`/`or` blocks would otherwise blow the
 *  V8 stack. 64 covers any reasonable hand-authored Base while leaving
 *  generous headroom over the few-deep nests Obsidian itself produces. */
const MAX_FILTER_DEPTH = 64;

function flattenFilter(filter: BaseFilter | BaseFilter[] | undefined): BaseFilter | undefined {
  if (filter === undefined) return undefined;
  if (Array.isArray(filter)) return { and: filter };
  return filter;
}

/**
 * Evaluate a Base filter against a single row. Unrecognized clauses log a
 * warning and short-circuit to `true` so the row is included rather than
 * silently dropped.
 */
export function evaluateFilter(
  row: BaseRow,
  filter: BaseFilter | undefined,
  ctx: EvaluationContext,
  depth = 0,
): boolean {
  if (depth > MAX_FILTER_DEPTH) {
    // Bail out instead of exploding the stack. Returning `true` is the
    // permissive fallback the rest of the evaluator already uses for
    // unrecognized shapes — surfacing a warning lets the user fix the Base.
    ctx.warnings.push(`Filter recursion exceeded ${MAX_FILTER_DEPTH} levels; clauses past this depth were skipped.`);
    return true;
  }
  if (filter === undefined) return true;
  if (typeof filter === "string") return evaluateExpression(row, filter, ctx);
  if ("and" in filter) return filter.and.every((f) => evaluateFilter(row, f, ctx, depth + 1));
  if ("or" in filter) return filter.or.some((f) => evaluateFilter(row, f, ctx, depth + 1));
  if ("not" in filter) return !evaluateFilter(row, filter.not, ctx, depth + 1);
  ctx.warnings.push(`Unknown filter shape: ${JSON.stringify(filter)}`);
  return true;
}

const FUNC_RE = /^([A-Za-z][A-Za-z0-9_.]*)\s*\(([\s\S]*)\)\s*$/;
const COMPARISON_RE = /^(.+?)\s*(==|!=|>=|<=|>|<|contains|startsWith|endsWith)\s*(.+?)\s*$/;

function evaluateExpression(row: BaseRow, expr: string, ctx: EvaluationContext): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return true;

  // Function-call form: `name(args)`.
  const fn = trimmed.match(FUNC_RE);
  if (fn) return evaluateFunction(row, fn[1], splitArgs(fn[2]), ctx);

  // Comparison form: `lhs OP rhs`.
  const cmp = trimmed.match(COMPARISON_RE);
  if (cmp) return evaluateComparison(row, cmp[1], cmp[2], cmp[3], ctx);

  // Bare identifier: truthiness check on a property.
  const v = readProperty(row, trimmed);
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function splitArgs(raw: string): string[] {
  // Simple comma-split that respects double-quoted strings. Adequate for the
  // filter syntax we accept; doesn't try to handle nested function calls.
  const out: string[] = [];
  let buf = "";
  let inString: '"' | "'" | "" = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      buf += ch;
      if (ch === inString && raw[i - 1] !== "\\") inString = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function unquote(token: string): string | null {
  const t = token.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return null;
}

function literalOrProperty(row: BaseRow, token: string): unknown {
  const lit = unquote(token);
  if (lit !== null) return lit;
  const t = token.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return readProperty(row, t);
}

/**
 * Read a dot-path against a row. Special prefixes:
 *   - file.name        → file basename without extension
 *   - file.path        → vault-relative path
 *   - file.tags        → array of tags
 *   - <key>            → frontmatter key
 *   - tags             → row.tags (alias for file.tags)
 */
function readProperty(row: BaseRow, expr: string): unknown {
  const path = expr.trim();
  if (path === "file.name") {
    const m = row.path.match(/([^/]+)\.[^.]+$/);
    return m ? m[1] : row.path;
  }
  if (path === "file.path") return row.path;
  if (path === "file.tags" || path === "tags") return row.tags;
  // Dotted frontmatter access — `metadata.author` etc.
  const parts = path.split(".");
  let cur: unknown = row.frontmatter;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function evaluateFunction(
  row: BaseRow,
  name: string,
  args: string[],
  ctx: EvaluationContext,
): boolean {
  switch (name) {
    case "taggedWith":
    case "file.hasTag": {
      const tagArg = args.length === 2 ? unquote(args[1]) : unquote(args[0]);
      if (tagArg === null) {
        ctx.warnings.push(`taggedWith expects a quoted tag name; got: ${args.join(", ")}`);
        return false;
      }
      const want = tagArg.replace(/^#/, "").toLowerCase();
      return row.tags.some((t) => {
        const norm = t.toLowerCase();
        return norm === want || norm.startsWith(want + "/");
      });
    }
    case "file.inFolder": {
      const folder = unquote(args[0] ?? "");
      if (folder === null) return false;
      const norm = folder.replace(/^\/+|\/+$/g, "");
      if (norm === "") return true;
      return row.path.startsWith(norm + "/") || row.path === norm;
    }
    default:
      ctx.warnings.push(`Unknown filter function: ${name}`);
      return true;
  }
}

function evaluateComparison(
  row: BaseRow,
  lhs: string,
  op: string,
  rhs: string,
  _ctx: EvaluationContext,
): boolean {
  const left = literalOrProperty(row, lhs);
  const right = literalOrProperty(row, rhs);
  switch (op) {
    case "==": return looseEqual(left, right);
    case "!=": return !looseEqual(left, right);
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const a = Number(left);
      const b = Number(right);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === ">") return a > b;
      if (op === ">=") return a >= b;
      if (op === "<") return a < b;
      return a <= b;
    }
    case "contains": {
      if (Array.isArray(left)) return left.map(String).includes(String(right));
      return String(left ?? "").includes(String(right ?? ""));
    }
    case "startsWith": return String(left ?? "").startsWith(String(right ?? ""));
    case "endsWith": return String(left ?? "").endsWith(String(right ?? ""));
    default: return false;
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * Apply Base filters across a set of pre-built rows. Returns matching rows
 * plus any warnings emitted by unrecognized filter clauses.
 */
export function queryBase(
  rows: readonly BaseRow[],
  base: BaseDocument,
  viewName?: string,
): QueryResult {
  const ctx: EvaluationContext = { warnings: [] };
  const baseFilter = flattenFilter(base.filters as BaseFilter | BaseFilter[] | undefined);
  let viewFilter: BaseFilter | undefined;
  let order: string[] | undefined;

  if (viewName && Array.isArray(base.views)) {
    const view = base.views.find((v) => v.name === viewName || v.type === viewName);
    if (!view) {
      ctx.warnings.push(`View not found: "${viewName}"; using base-level filters only.`);
    } else {
      viewFilter = flattenFilter(view.filters as BaseFilter | BaseFilter[] | undefined);
      order = Array.isArray(view.order) ? view.order : undefined;
    }
  }

  const matches = rows.filter((row) =>
    evaluateFilter(row, baseFilter, ctx) && evaluateFilter(row, viewFilter, ctx),
  );

  if (order && order.length > 0) {
    matches.sort((a, b) => {
      for (const key of order!) {
        const va = readProperty(a, key);
        const vb = readProperty(b, key);
        if (va === vb) continue;
        if (va === undefined || va === null) return 1;
        if (vb === undefined || vb === null) return -1;
        if (typeof va === "number" && typeof vb === "number") return va - vb;
        return String(va).localeCompare(String(vb));
      }
      return 0;
    });
  }

  return { rows: matches, warnings: ctx.warnings };
}
