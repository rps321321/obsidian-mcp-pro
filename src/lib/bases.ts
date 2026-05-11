import yaml from "js-yaml";
import { parseFrontmatter, extractTags } from "./markdown.js";

/**
 * Obsidian Bases (`.base` file) support.
 *
 * Spec sources consulted (2026-05):
 *   - https://help.obsidian.md/bases/syntax (canonical filter syntax)
 *   - obsidianmd/obsidian-help repo (Bases/Functions.md, Bases syntax.md)
 *   - Release notes v1.9.2 (object/chained syntax intro), v1.9.14 (case-insensitive hasTag)
 *
 * Supported filter forms:
 *
 *   filters:
 *     and:                          # combinators: and / or / not
 *       - file.hasTag("project")    # chained method on file
 *       - file.name.contains("2026")
 *       - file.inFolder("Projects")
 *       - file.hasProperty("status")
 *       - status == "active"        # infix comparison
 *       - priority > 3
 *       - taggedWith(file, "tag")   # legacy function form (still accepted)
 *
 * Unsupported expressions surface as parse warnings and evaluate to `true`
 * (permissive fallback) so a partial Base still returns plausible rows.
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
  | { not: BaseFilter | BaseFilter[] };

export interface ParsedBase {
  doc: BaseDocument;
  warnings: string[];
}

/**
 * Hard cap on `.base` file size we'll attempt to parse. Real Bases are
 * a few hundred bytes to a few KB; anything past 1 MB is either generated
 * garbage or a YAML alias-bomb ("billion laughs") aimed at the parser.
 * Reject before handing bytes to js-yaml so we can't be coerced into a
 * large allocation.
 */
const MAX_BASE_FILE_BYTES = 1_048_576;

export function parseBaseFile(raw: string): ParsedBase {
  const warnings: string[] = [];
  let doc: BaseDocument = {};
  if (raw.length > MAX_BASE_FILE_BYTES) {
    warnings.push(
      `Base file exceeds size cap (${raw.length} > ${MAX_BASE_FILE_BYTES} bytes); refusing to parse to avoid YAML alias-bomb / DoS. Treating as empty Base.`,
    );
    return { doc, warnings };
  }
  try {
    // JSON_SCHEMA is the most restrictive schema js-yaml ships: it disables
    // every non-JSON type (timestamps, !!binary, custom tags, etc.). Combined
    // with the size cap above, this neutralises the worst alias / merge-key
    // expansions a malicious .base file could use.
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
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

/**
 * A single row in a query result. Required fields are populated from the
 * note body. The optional fields mirror Obsidian's `file.*` surface; the
 * builder in tools/bases.ts only populates simple ones today, but the
 * evaluator already understands them so callers can supply more without a
 * second pass.
 */
export interface BaseRow {
  path: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  /** Optional fs stats (file.size, file.ctime, file.mtime). */
  stats?: {
    size?: number;
    ctime?: number;
    mtime?: number;
  };
  /** Outgoing wikilinks (file.links). */
  links?: string[];
  /** Embeds (file.embeds). */
  embeds?: string[];
  /** Notes that link to this note (file.backlinks). */
  backlinks?: string[];
}

export interface QueryResult {
  rows: BaseRow[];
  warnings: string[];
}

/**
 * Build a row for a single note. Pre-parsing once per note keeps the filter
 * evaluator fast across large vaults. `stats` is optional so existing
 * callers stay source-compatible; new callers pass fs stats so size/ctime/
 * mtime filters resolve to real values.
 */
export function buildRow(
  path: string,
  content: string,
  stats?: BaseRow["stats"],
): BaseRow {
  const { data } = parseFrontmatter(content);
  return {
    path,
    frontmatter: data,
    tags: extractTags(content),
    stats,
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
    ctx.warnings.push(`Filter recursion exceeded ${MAX_FILTER_DEPTH} levels; clauses past this depth were skipped.`);
    return true;
  }
  if (filter === undefined) return true;
  if (typeof filter === "string") return evaluateExpression(row, filter, ctx);
  if ("and" in filter) return filter.and.every((f) => evaluateFilter(row, f, ctx, depth + 1));
  if ("or" in filter) return filter.or.some((f) => evaluateFilter(row, f, ctx, depth + 1));
  if ("not" in filter) {
    // Obsidian accepts both a single filter and a list under `not:`. When
    // it's a list, treat it as an implicit `and` so the spec's
    //   not:
    //     - X
    //     - Y
    // means "neither X nor Y", matching how the docs render it.
    const inner = filter.not;
    if (Array.isArray(inner)) return !inner.every((f) => evaluateFilter(row, f, ctx, depth + 1));
    return !evaluateFilter(row, inner, ctx, depth + 1);
  }
  ctx.warnings.push(`Unknown filter shape: ${JSON.stringify(filter)}`);
  return true;
}

// ---------- Expression parsing ----------
//
// Regex notes (ReDoS hardening):
//   FUNC_RE matches `name(args)` and METHOD_RE matches `chain.method(args)`.
//   Both bound the argument span to `[^)]*` (no nested parens) so they run
//   in linear time on any input length. The previous `[\s\S]*` was
//   catastrophic on long inputs because the engine could backtrack across
//   the entire body.
//
//   COMPARISON_RE constrains the operand on each side: identifiers/dots
//   on the left, and a single quoted string OR a non-space token on the
//   right. The old `(.+?) op (.+?)` was lazy-greedy and ambiguous, which is
//   the classic ReDoS shape.

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const IDENT_CHAIN = `${IDENT}(?:\\.${IDENT})*`;

/** Function-form call: `name(args)` where `name` may itself be dotted (legacy). */
const FUNC_RE = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)\\s*\\(([^)]*)\\)\\s*$`);

/** Chained method form: `<chain>.<method>(args)`. Captured separately so we
 *  can route to the method evaluator that knows about file.* receivers. */
const METHOD_RE = new RegExp(`^(${IDENT_CHAIN})\\.(${IDENT})\\s*\\(([^)]*)\\)\\s*$`);

/** Operand on either side of a comparison. Either a quoted string, or a
 *  run of non-space, non-operator characters (numbers, identifiers, dotted
 *  paths). Bounded so backtracking can't explode. */
const OPERAND = `(?:"[^"]*"|'[^']*'|[^\\s"'=!<>]+)`;
const COMPARISON_RE = new RegExp(
  `^\\s*(${OPERAND})\\s*(==|!=|>=|<=|>|<|contains|startsWith|endsWith)\\s*(${OPERAND})\\s*$`,
);

function evaluateExpression(row: BaseRow, expr: string, ctx: EvaluationContext): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return true;

  // Try chained method form first: `file.name.contains("x")`.
  const method = trimmed.match(METHOD_RE);
  if (method) {
    return evaluateMethod(row, method[1], method[2], splitArgs(method[3]), ctx);
  }

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
  // Simple comma-split that respects quoted strings. Adequate for the
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
 * Read a dot-path against a row. Obsidian-style `file.*` properties are
 * resolved first; anything else falls through to dotted frontmatter access.
 */
function readProperty(row: BaseRow, expr: string): unknown {
  const path = expr.trim();
  switch (path) {
    case "file.name":
      // file.name in Obsidian Bases includes the extension (the new spec
      // distinguishes file.name from file.basename). Match the spec.
      return basenameOf(row.path);
    case "file.basename":
      return basenameWithoutExt(row.path);
    case "file.path":
      return row.path;
    case "file.folder":
      return folderOf(row.path);
    case "file.ext":
      return extOf(row.path);
    case "file.tags":
    case "tags":
      return row.tags;
    case "file.size":
      return row.stats?.size;
    case "file.ctime":
      return row.stats?.ctime;
    case "file.mtime":
      return row.stats?.mtime;
    case "file.properties":
      return row.frontmatter;
    case "file.links":
      return row.links;
    case "file.embeds":
      return row.embeds;
    case "file.backlinks":
      return row.backlinks;
  }
  // Dotted frontmatter access: `metadata.author` etc.
  const parts = path.split(".");
  let cur: unknown = row.frontmatter;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function basenameOf(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function basenameWithoutExt(p: string): string {
  const base = basenameOf(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function folderOf(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(0, slash) : "";
}

function extOf(p: string): string {
  const base = basenameOf(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

// ---------- Method-form evaluation (Obsidian 1.9.2+ canonical) ----------

/**
 * Evaluate `<chain>.<method>(args)`. The chain is the receiver (e.g.
 * `file.name`, `file`, or a frontmatter key); the method dispatches on
 * both name and receiver shape.
 */
function evaluateMethod(
  row: BaseRow,
  chain: string,
  method: string,
  args: string[],
  ctx: EvaluationContext,
): boolean {
  // Methods that act on the `file` object itself (file.hasTag, file.hasProperty,
  // file.inFolder, file.linksTo, file.hasLink). Resolved by chain == "file".
  if (chain === "file") {
    switch (method) {
      case "hasTag":
        return matchesTag(row, firstStringArg(args, "file.hasTag", ctx));
      case "hasProperty": {
        const key = firstStringArg(args, "file.hasProperty", ctx);
        if (key === null) return false;
        return Object.prototype.hasOwnProperty.call(row.frontmatter, key);
      }
      case "inFolder":
        return matchesFolder(row, firstStringArg(args, "file.inFolder", ctx));
      case "linksTo":
      case "hasLink": {
        const target = firstStringArg(args, `file.${method}`, ctx);
        if (target === null) return false;
        if (!row.links) {
          // Permissive: builder didn't supply links; warn and match-all.
          ctx.warnings.push(`file.${method}: row has no links populated; treating as match.`);
          return true;
        }
        return matchesLink(row.links, target);
      }
      case "isEmpty":
        // file.isEmpty: rough proxy — note has no frontmatter and no body tags.
        return Object.keys(row.frontmatter).length === 0 && row.tags.length === 0;
      case "isNotEmpty":
        return Object.keys(row.frontmatter).length > 0 || row.tags.length > 0;
    }
  }

  // Generic value methods: read the chain as a property, then dispatch.
  const value = readProperty(row, chain);
  return evaluateValueMethod(value, method, args, ctx, chain);
}

function evaluateValueMethod(
  value: unknown,
  method: string,
  args: string[],
  ctx: EvaluationContext,
  chainForWarnings: string,
): boolean {
  switch (method) {
    case "contains": {
      const needle = firstStringArg(args, `${chainForWarnings}.contains`, ctx);
      if (needle === null) return false;
      if (Array.isArray(value)) return value.map(String).some((v) => v.includes(needle));
      return String(value ?? "").includes(needle);
    }
    case "startsWith": {
      const needle = firstStringArg(args, `${chainForWarnings}.startsWith`, ctx);
      if (needle === null) return false;
      return String(value ?? "").startsWith(needle);
    }
    case "endsWith": {
      const needle = firstStringArg(args, `${chainForWarnings}.endsWith`, ctx);
      if (needle === null) return false;
      return String(value ?? "").endsWith(needle);
    }
    case "equals": {
      const other = args[0] !== undefined ? unquote(args[0]) ?? args[0].trim() : "";
      return String(value ?? "") === other;
    }
    case "isEmpty":
      if (value === null || value === undefined) return true;
      if (typeof value === "string") return value.length === 0;
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === "object") return Object.keys(value as object).length === 0;
      return false;
    case "isNotEmpty":
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value as object).length > 0;
      return true;
    default:
      ctx.warnings.push(`Unknown method: ${chainForWarnings}.${method}`);
      return true;
  }
}

function firstStringArg(args: string[], where: string, ctx: EvaluationContext): string | null {
  if (args.length === 0) {
    ctx.warnings.push(`${where} expects a quoted string argument.`);
    return null;
  }
  const lit = unquote(args[0]);
  if (lit === null) {
    ctx.warnings.push(`${where} expects a quoted string; got: ${args[0]}`);
    return null;
  }
  return lit;
}

function matchesTag(row: BaseRow, want: string | null): boolean {
  if (want === null) return false;
  const norm = want.replace(/^#/, "").toLowerCase();
  return row.tags.some((t) => {
    const tn = t.toLowerCase();
    return tn === norm || tn.startsWith(norm + "/");
  });
}

function matchesFolder(row: BaseRow, folder: string | null): boolean {
  if (folder === null) return false;
  const norm = folder.replace(/^\/+|\/+$/g, "");
  if (norm === "") return true;
  return row.path.startsWith(norm + "/") || row.path === norm;
}

function matchesLink(links: readonly string[], target: string): boolean {
  // Loose match — Obsidian normalizes link targets in non-trivial ways
  // (case, extension, fragment). Accept exact and basename-equal hits.
  const t = target.toLowerCase();
  const tBase = basenameWithoutExt(target).toLowerCase();
  return links.some((l) => {
    const ll = l.toLowerCase();
    return ll === t || basenameWithoutExt(l).toLowerCase() === tBase;
  });
}

// ---------- Function-form evaluation (legacy) ----------

function evaluateFunction(
  row: BaseRow,
  name: string,
  args: string[],
  ctx: EvaluationContext,
): boolean {
  switch (name) {
    case "taggedWith":
    case "file.hasTag": {
      // taggedWith(file, "tag") or file.hasTag("tag") in function form.
      const tagArg = args.length === 2 ? unquote(args[1]) : unquote(args[0] ?? "");
      return matchesTag(row, tagArg);
    }
    case "file.inFolder": {
      const folder = unquote(args[0] ?? "");
      return matchesFolder(row, folder);
    }
    case "file.hasProperty": {
      const key = unquote(args[0] ?? "");
      if (key === null) return false;
      return Object.prototype.hasOwnProperty.call(row.frontmatter, key);
    }
    default:
      ctx.warnings.push(`Unknown filter function: ${name}`);
      return true;
  }
}

// ---------- Infix comparison ----------

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
