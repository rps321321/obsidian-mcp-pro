# HTTP Roles

These APIs are available in published core 4.1.0 and newer. Core 4.0.1 does not
export the Role API. Use published core 4.1.1 or newer, which requires SDK
1.32.1 or newer for the configured input budget; see the [consumer dependency correction](dependency-security.md#consumer-sdk-resolution-correction-in-411).

A bearer token selects one Role. A Role stores explicit Tool names. Multiple tokens can share that Role.

```ts
import {
  buildMcpServer,
  createMcpServerServices,
  startHttpServer,
  TOOL_NAMES,
  type Role,
} from "obsidian-mcp-pro";

const vaultPath = process.env.OBSIDIAN_VAULT_PATH!;
const services = createMcpServerServices(vaultPath);
const roles: Role[] = [
  { id: "search", tools: ["search_notes", "search_by_tag"] },
  { id: "append", tools: ["append_to_note"] },
  { id: "full-access", tools: [...TOOL_NAMES] },
];
// Save the roles to your application's settings at creation time.
// Load that saved list on subsequent starts, instead of rebuilding Full Access.
const tokens = [
  { token: process.env.SEARCH_AGENT_TOKEN!, roleId: "search" },
  { token: process.env.APPEND_AGENT_TOKEN!, roleId: "append" },
];
const server = await startHttpServer({
  host: "127.0.0.1",
  port: 3333,
  roles,
  tokens,
  allowedHosts: ["vault.example.com"],
  buildMcpServer: (options) => buildMcpServer(vaultPath, services, options),
  installSignalHandlers: false,
  onAudit: (event) => {
    /* Forward the authorization event to your audit sink. */
  },
});

// Replace the complete configuration. This revokes the append token.
await server.updateAuthorization({ roles, tokens: tokens.slice(0, 1) });
await server.stop();
```

## Configuration and compatibility

`RoleHttpServerOptions` accepts `roles: { id, tools }[]` and `tokens: { token, roleId }[]`.
`HttpServerOptions` retains its required `bearerToken` and zero-argument factory for existing single-token embedders.
`startHttpServer` returns an `AuthorizedHttpServerHandle`, which extends `HttpServerHandle` with `updateAuthorization`.

With `tokens` omitted, startup requires `bearerToken` and synthesizes a Full Access snapshot for this process. This preserves legacy discovery and custom factories. To persist migration across upgrades, save `[...TOOL_NAMES]` once and use Roles thereafter. The library does not write application settings. Stdio remains unfiltered.

With `tokens` present, `bearerToken` is illegal. Invalid arrays, duplicate or empty Role IDs, duplicate tokens, empty tokens, surrounding token whitespace, unknown Role assignments, and unknown or duplicate Tool names fail before listening. An empty Role is valid. Empty `roles` and `tokens` arrays deny all bearer authentication.

Configuration is copied at startup and during updates. Mutating the supplied arrays does not change live authorization. Invalid updates leave the previous configuration intact. `updateAuthorization` accepts a complete replacement, validates it, then synchronously removes affected sessions before awaiting transport closure. Revocation, reassignment, and changed Tool lists require those clients to initialize again. Unchanged sessions remain usable. The first update from legacy mode closes all existing legacy sessions. The API cannot roll back a tool operation already executing before revocation.

A Role named `full-access` has no special runtime meaning. New Tools remain disabled in saved Roles until their names are added explicitly.

## Registration and dispatch

`buildMcpServer(vaultPath, services?, { tools?: readonly string[] })` registers only selected Tools through `defineTool`. Omit `tools` for all Tools. Pass `[]` for none. Unknown or duplicate names throw. Empty discovery lists return successful empty results.

Role factories must forward the provided options to the core `buildMcpServer`. Missing or mismatched registration metadata causes initialization to fail, instead of accepting an unfiltered server. Adding a Tool outside the snapshot through `registerTool` also throws. Existing legacy factories are unchanged, but must forward options before switching to Roles through `updateAuthorization`.

Each session stores a hashed token identity and its Role snapshot. Another valid token receives 401 when it attempts to use that session, even if both tokens share a Role. HTTP rechecks authorization after reading request bodies and before dispatch. Tool callbacks check again before entering the handler. Direct requests for omitted Tools are rejected. A batch containing a denied tool, resource, or prompt request is rejected before any entry is dispatched.

Resources and prompts are filtered separately because they have separate SDK registries.

| Resource                  | Required Tool    |
| ------------------------- | ---------------- |
| `obsidian://note/{+path}` | `get_note`       |
| `obsidian://tags`         | `list_tags`      |
| `obsidian://daily`        | `get_daily_note` |

| Prompt                 | Required Tools                                                      |
| ---------------------- | ------------------------------------------------------------------- |
| `daily-review`         | `get_daily_note`, `get_recent_notes`, `get_note`, `list_tags`       |
| `weekly-rollup`        | `get_recent_notes`                                                  |
| `find-stale-notes`     | `get_recent_notes`, `get_note`, `find_orphans`, `find_broken_links` |
| `extract-action-items` | `get_note`, `search_by_tag`                                         |
| `build-moc`            | `search_by_tag`, `list_notes`, `get_note`, `create_note`            |

The embedding application is trusted code. Deliberately replacing SDK handlers, changing registration methods, or exposing the vault through another endpoint is outside bearer authorization. Arbitrary custom MCP implementations are supported only by legacy single-token mode.

## Audit and limits

Authorization events contain `roleId`, `sessionId`, `tool`, `decision`, and `reason`. Unavailable identifiers are omitted. `tool` is restricted to known Tool names; unknown request strings are never copied into events. Events describe authentication, session creation or invalidation, and tool/resource/prompt authorization decisions. An allow event does not imply that the operation succeeded. Events go to the configured logger and optional `onAudit` callback. Callback exceptions do not change authorization. Tokens, arguments, URIs, and note contents are not included.

`allowedHosts` remains server-wide and checks destination hosts before bearer resolution. The process-global `OBSIDIAN_READ_PATHS` and `OBSIDIAN_WRITE_PATHS` settings do not isolate individual tokens. Roles do not restrict arguments or folders.

Search tools may return snippets, semantic chunks, full content with supported options, or Base query rows. Write tool responses may expose existing content or metadata. Read-only Roles must omit `index_vault`, which sends note text to the embedding provider and writes an index. `search_semantic` sends the query to the provider.

This implements the library and HTTP portion of issue #284. The companion Role editor, token settings and persisted migration shipped in [plugin 0.4.0](https://github.com/rps321321/obsidian-mcp-pro-plugin/releases/tag/v0.4.0), following [PR #23](https://github.com/rps321321/obsidian-mcp-pro-plugin/pull/23), and use published core 4.1.1. See the [native validation record](https://github.com/rps321321/obsidian-mcp-pro-plugin/blob/v0.4.0/docs/role-settings-validation.md) for the tested Windows environment and limitations. CLI Role configuration is not included.

Run `npx vitest run src/__tests__/roles.test.ts` for the HTTP and registration acceptance tests.
