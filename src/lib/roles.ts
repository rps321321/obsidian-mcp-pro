import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TOOL_NAMES: readonly string[] = Object.freeze([
  "get_note",
  "list_notes",
  "get_daily_note",
  "get_recent_notes",
  "get_vault_stats",
  "resolve_alias",
  "search_notes",
  "search_by_frontmatter",
  "create_note",
  "create_daily_note",
  "append_to_note",
  "prepend_to_note",
  "update_frontmatter",
  "move_note",
  "delete_note",
  "list_sections",
  "update_section",
  "insert_at_section",
  "edit_block",
  "replace_in_note",
  "list_tags",
  "search_by_tag",
  "rename_tag",
  "get_backlinks",
  "get_outlinks",
  "get_graph_neighbors",
  "find_broken_links",
  "find_orphans",
  "list_canvases",
  "read_canvas",
  "add_canvas_node",
  "add_canvas_edge",
  "list_bases",
  "read_base",
  "query_base",
  "list_attachments",
  "get_attachment",
  "find_unused_attachments",
  "index_vault",
  "search_semantic",
  "find_similar_notes",
]);
export interface Role {
  readonly id: string;
  readonly tools: readonly string[];
}
export interface TokenAssignment {
  readonly token: string;
  readonly roleId: string;
}
export interface AuthorizationOptions {
  readonly roles: readonly Role[];
  readonly tokens: readonly TokenAssignment[];
}
export interface McpServerOptions {
  readonly tools?: readonly string[];
}
export interface AuthorizationAuditEvent {
  readonly roleId?: string;
  readonly sessionId?: string;
  readonly tool?: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
}
export interface ResolvedRole {
  readonly identity: string;
  readonly roleId: string;
  readonly tools: readonly string[];
}

export const PROMPT_TOOLS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "daily-review": [
      "get_daily_note",
      "get_recent_notes",
      "get_note",
      "list_tags",
    ],
    "weekly-rollup": ["get_recent_notes"],
    "find-stale-notes": [
      "get_recent_notes",
      "get_note",
      "find_orphans",
      "find_broken_links",
    ],
    "extract-action-items": ["get_note", "search_by_tag"],
    "build-moc": ["search_by_tag", "list_notes", "get_note", "create_note"],
  });
for (const tools of Object.values(PROMPT_TOOLS)) Object.freeze(tools);
function requireArray(value: unknown): void {
  if (!Array.isArray(value))
    throw new Error("Role tools, roles and tokens must be arrays");
}
export function copyToolNames(tools: readonly string[]): readonly string[] {
  requireArray(tools);
  const names = [...tools];
  if (
    names.some((t) => typeof t !== "string" || !TOOL_NAMES.includes(t)) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Role tools must be distinct known Tool names");
  }
  return Object.freeze(names.sort());
}
export function tokenIdentity(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function compileAuthorization(
  options: AuthorizationOptions
): readonly ResolvedRole[] {
  requireArray(options.roles);
  requireArray(options.tokens);
  const roles = new Map<string, readonly string[]>();
  for (const role of options.roles) {
    if (
      !role ||
      typeof role.id !== "string" ||
      !role.id.trim() ||
      roles.has(role.id)
    )
      throw new Error("Role IDs must be non-empty and distinct");
    roles.set(role.id, copyToolNames(role.tools));
  }
  const identities = new Set<string>();
  return Object.freeze(
    Array.from(options.tokens, (assignment) => {
      if (
        !assignment ||
        typeof assignment.token !== "string" ||
        !assignment.token ||
        assignment.token.trim() !== assignment.token
      )
        throw new Error(
          "Token must be non-empty without surrounding whitespace"
        );
      const identity = tokenIdentity(assignment.token);
      if (identities.has(identity)) throw new Error("Duplicate bearer token");
      identities.add(identity);
      const tools = roles.get(assignment.roleId);
      if (!tools) throw new Error("Token references an unknown Role");
      return Object.freeze({ identity, roleId: assignment.roleId, tools });
    })
  );
}
export function resolveIdentity(
  assignments: readonly ResolvedRole[],
  identity: string
): ResolvedRole | undefined {
  let found: ResolvedRole | undefined;
  for (const assignment of assignments) {
    if (
      timingSafeEqual(
        Buffer.from(assignment.identity, "hex"),
        Buffer.from(identity, "hex")
      )
    )
      found = assignment;
  }
  return found;
}
export function sameRole(
  a: ResolvedRole,
  b: ResolvedRole | undefined
): boolean {
  return (
    !!b &&
    a.roleId === b.roleId &&
    a.tools.length === b.tools.length &&
    a.tools.every((t, i) => t === b.tools[i])
  );
}

const serverTools = new WeakMap<McpServer, readonly string[]>();
export function configureServerTools(
  server: McpServer,
  tools: readonly string[]
): void {
  const snapshot = copyToolNames(tools);
  serverTools.set(server, snapshot);
  const register = server.registerTool.bind(server);
  server.registerTool = ((...args: [string, ...unknown[]]) => {
    if (!snapshot.includes(args[0]))
      throw new Error("Tool is outside this server's Role");
    return Reflect.apply(register, server, args) as ReturnType<
      typeof server.registerTool
    >;
  }) as typeof server.registerTool;
}
export function toolAllowed(server: McpServer, name: string): boolean {
  return serverTools.get(server)?.includes(name) ?? true;
}
export function hasServerTools(
  server: McpServer,
  tools: readonly string[]
): boolean {
  const actual = serverTools.get(server);
  return (
    !!actual &&
    actual.length === tools.length &&
    actual.every((t) => tools.includes(t))
  );
}

const invocationGuards = new WeakMap<McpServer, () => boolean>();
export function bindInvocationGuard(
  server: McpServer,
  guard: () => boolean
): void {
  invocationGuards.set(server, guard);
}
export function invocationAllowed(server: McpServer): boolean {
  return invocationGuards.get(server)?.() ?? true;
}
