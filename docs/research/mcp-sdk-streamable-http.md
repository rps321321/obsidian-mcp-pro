# MCP SDK 1.29.0 facts: Host, session, and stateless HTTP

Facts only. No product policy.

Pinned sources:

- Installed npm package `@modelcontextprotocol/sdk@1.29.0` (`package-lock.json` resolves `sdk-1.29.0.tgz`; `node_modules/@modelcontextprotocol/sdk/package.json` `"version": "1.29.0"`). The tarball ships `dist/` only.
- Matching git tag [`v1.29.0`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v1.29.0) (`e12cbd7078db388152f6e839abdbe09ba01f3f32`). TypeScript sources and `docs/server.md` are cited from that tag.
- MCP spec revision that this SDK release tracks: [2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (SDK `docs/server.md` at v1.29.0 links this URL).

This repo’s `src/http-server.ts` is **not** a source of SDK behavior. It is noted only where it names which SDK APIs it constructs.

## 1. Host validation

### Streamable HTTP `allowedHosts` (the transport option)

`StreamableHTTPServerTransport` is a Node wrapper around `WebStandardStreamableHTTPServerTransport` and passes constructor options through unchanged.

Source: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js` (`StreamableHTTPServerTransport` constructor); git tag [`src/server/webStandardStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/webStandardStreamableHttp.ts) (`WebStandardStreamableHTTPServerTransportOptions.allowedHosts`, `validateRequestHeaders`).

Facts:

- `allowedHosts` is documented as “List of allowed host header values”. It is **deprecated** on the transport in 1.29.0 (“Use external middleware for host validation instead”).
- Host checks run only when **both** are true:
  1. `enableDnsRebindingProtection` is true (default **false**).
  2. `_allowedHosts` is set **and** `_allowedHosts.length > 0`.
- Comparison is `this._allowedHosts.includes(hostHeader)` where `hostHeader = req.headers.get('host')` (Fetch `Headers.get`, after the Node wrapper converts `IncomingMessage` to a Web `Request`).
- That is **exact string match** of the full `Host` header value:
  - Case-sensitive (`Array.prototype.includes` / SameValueZero). Node `Headers.get('host')` preserves the sent value (e.g. `LocalHost:3000` stays `LocalHost:3000`).
  - Port is part of the string when the client sent one (`127.0.0.1` ≠ `127.0.0.1:3847`).
  - IPv6 is not parsed. A typical loopback Host is `[::1]:<port>` or `[::1]`; it matches only if that exact string is in the array.
  - `"*"` has **no** wildcard meaning. `['*'].includes('localhost')` is false; `"*"` would match only a Host header whose value is the single character `*`.
- Missing Host (`!hostHeader`) is a rejection, same as a non-matching value.
- Rejection HTTP status: **403**. JSON-RPC body `{ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid Host header: <value>' }, id: null }` via `createJsonErrorResponse(403, -32000, error)`.
- Logging: the transport calls `this.onerror?.(new Error(error))`. There is **no** `console.log` / SDK logger in `validateRequestHeaders`. If the application did not set `transport.onerror`, the SDK emits no log line.

Origin is a sibling check in the same function: if `allowedOrigins` is non-empty, a **present** Origin that fails `includes` is also 403 (`Invalid Origin header: …`) and also only `onerror?.`. A missing Origin is allowed.

MCP spec 2025-11-25 Transports “Security Warning” requires Origin validation and 403 when Origin is present and invalid. It does **not** define a Host allowlist API. Host allowlisting is an SDK (and middleware) mechanism.

### Separate Express middleware (not the transport option)

`hostHeaderValidation(allowedHostnames)` in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/middleware/hostHeaderValidation.js` (git tag [`src/server/middleware/hostHeaderValidation.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/middleware/hostHeaderValidation.ts)):

- Parses **hostname only** with `new URL(\`http://${hostHeader}\`).hostname` (port-agnostic).
- IPv6: JSDoc says provide brackets, e.g. `'[::1]'`. Node’s `URL.hostname` for `http://[::1]:3847` is `"[::1]"`.
- Match is still `allowedHostnames.includes(hostname)` (exact, case-sensitive, no `"*"` glob).
- Rejection: HTTP **403** with JSON-RPC `-32000` (`Missing Host header` / `Invalid Host header: …` / `Invalid Host: …`). No SDK log beyond the HTTP response.
- `createMcpExpressApp()` applies this middleware (not the transport `allowedHosts` option) for localhost binds, or for an explicit `allowedHosts` option on the Express factory. Official v1 docs: [Server → DNS rebinding protection](https://ts.sdk.modelcontextprotocol.io/server) and git tag [`docs/server.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md) “DNS rebinding protection”.

This repo constructs `new StreamableHTTPServerTransport({ allowedHosts, allowedOrigins, enableDnsRebindingProtection: true })` (the transport option, not `hostHeaderValidation`).

`[NOT FOUND]` in SDK 1.29.0 for: case-folding, port stripping, IPv6 canonicalization, or `"*"` on the Streamable HTTP `allowedHosts` option.

## 2. Session binding

### How a session is created at initialize

Source: git tag [`webStandardStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/webStandardStreamableHttp.ts) `handlePostRequest`; installed `dist/esm/server/webStandardStreamableHttp.js`.

On a POST whose parsed JSON-RPC messages include an initialize request (`isInitializeRequest`):

1. Reject if this transport is already initialized **and** already has a `sessionId` (400, `-32600`, `Invalid Request: Server already initialized`).
2. Reject if the batch has more than one message (400, `-32600`, `Invalid Request: Only one initialization request is allowed`).
3. `this.sessionId = this.sessionIdGenerator?.()`.
4. `this._initialized = true`.
5. If both `this.sessionId` and `onsessioninitialized` are set, `await onsessioninitialized(this.sessionId)`.
6. Later, if `this.sessionId !== undefined`, response headers include `mcp-session-id`.

`sessionIdGenerator` JSDoc: the ID SHOULD be globally unique and cryptographically secure. If the generator is omitted, “session management is disabled (stateless mode)” and no Session ID is included in responses.

Spec 2025-11-25 Transports “Session Management”: server MAY assign a session ID at initialization via `MCP-Session-Id` on the `InitializeResult` HTTP response; clients MUST send it on subsequent requests; servers that require it SHOULD 400 when it is missing (other than initialize); after the server terminates a session it MUST 404 that ID.

The SDK stores **one** `sessionId` on the transport instance. Multi-session routing (map of id → transport) is application code, via `onsessioninitialized` / `onsessionclosed`. The SDK does not keep a global session table.

### Lookup and mismatch

`validateSession` (same file):

- If `sessionIdGenerator === undefined`: skip (stateless).
- If not `_initialized`: 400, `-32000`, `Bad Request: Server not initialized`.
- Header `mcp-session-id` missing: 400, `-32000`, `Bad Request: Mcp-Session-Id header is required`.
- Header present but `sessionId !== this.sessionId` (exact string `!==`): **404**, JSON-RPC **`-32001`**, `Session not found`. Also `onerror?.(new Error('Session not found'))`.

JSDoc on the class: “Requests with invalid session IDs are rejected with 404 Not Found”. Spec: 404 means the client MUST start a new session with a new `InitializeRequest` and no session ID.

Header name on the wire is `mcp-session-id` in Fetch `Headers` (HTTP names are case-insensitive). Comparison of the **value** is case-sensitive `!==`.

### Bearer vs session

The Streamable HTTP transport has **no bearer / Authorization concept**. It never reads `Authorization`. Session validation is only `Mcp-Session-Id` vs `this.sessionId`.

The SDK **does** ship a separate OAuth middleware `requireBearerAuth` (`dist/esm/server/auth/middleware/bearerAuth.js`). That middleware verifies a Bearer token, attaches `req.auth`, and returns 401/403 on failure. `StreamableHTTPServerTransport.handleRequest` forwards `req.auth` as `authInfo` into `onmessage` extras for **that HTTP request**. It does not store `authInfo` on the session and does not compare a later request’s bearer to the initialize bearer.

Spec 2025-11-25 [Security Best Practices → Session Hijacking](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices#session-hijacking):

- MCP servers that implement authorization **MUST** verify all inbound requests.
- MCP servers **MUST NOT** use sessions for authentication.
- MCP servers **SHOULD** bind session IDs to user-specific information (example key format `<user_id>:<session_id>`).

That bind is specified as application behavior, not implemented inside `validateSession`.

`[NOT FOUND]` in the Streamable HTTP transport: any check that a later request’s bearer (or `authInfo`) matches the token used at initialize. A different valid bearer that presents an existing `Mcp-Session-Id` is a session-ID match as far as the SDK transport is concerned; any extra bind is outside the transport.

## 3. Tool registration vs filtering

Source: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` (`setToolRequestHandlers`, `_createRegisteredTool`); git tag [`src/server/mcp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/mcp.ts).

Facts:

- `McpServer` keeps one map, `_registeredTools`. `registerTool` / `tool()` insert there with `enabled: true` and then call `setToolRequestHandlers()`.
- `tools/list` (`ListToolsRequestSchema` handler) returns `Object.entries(this._registeredTools).filter(([, tool]) => tool.enabled)`.
- `tools/call` (`CallToolRequestSchema` handler) looks up `this._registeredTools[request.params.name]`:
  - missing → `McpError(ErrorCode.InvalidParams, \`Tool ${name} not found\`)` (`-32602`).
  - present but `!tool.enabled` → `McpError(ErrorCode.InvalidParams, \`Tool ${name} disabled\`)`.
- `RegisteredTool.disable()` / `enable()` flip that same `enabled` flag and send `notifications/tools/list_changed`. There is no SDK API that hides a tool from `tools/list` while leaving `tools/call` open.
- If **no** tool is ever registered, `setToolRequestHandlers` never runs, so neither `tools/list` nor `tools/call` is installed. A `tools/call` then fails at the protocol layer as method-not-found (`ErrorCode.MethodNotFound = -32601`), not as “tool not found”.
- `Protocol.setRequestHandler` **replaces** any previous handler for that method (`dist/esm/shared/protocol.js`: “this will replace any previous request handler”). `assertCanSetRequestHandler` only blocks the *automatic* first install. An application can therefore replace **only** the `tools/list` handler after `McpServer` installed both; `tools/call` would still dispatch through `_registeredTools`. That replacement is not a documented “filter” API.

Official v1 docs (`docs/server.md` “Tool change notifications”) document `registerTool`, `remove()`, `enable()`, `disable()`, `update()`, and `sendToolListChanged()`. They do not document list-only omission.

**Answer:** omitting a tool from `tools/list` by the SDK’s own mechanism (`enabled: false` or never registering it) does **not** leave `tools/call` callable. A still-registered enabled tool is callable even if a *custom replaced* `tools/list` handler omits it.

## 4. Resources and prompts

Same file: `_registeredResources`, `_registeredResourceTemplates`, `_registeredPrompts`; `setResourceRequestHandlers`, `setPromptRequestHandlers`.

Facts:

- Tools, resources, and prompts are **independent maps** and independent handler installations. Registering a tool does not register or unregister resources or prompts.
- Resource handlers (`resources/list`, `resources/templates/list`, `resources/read`) are installed on first `registerResource` / resource-template registration. Prompt handlers (`prompts/list`, `prompts/get`) are installed on first `registerPrompt` / `prompt()`.
- List vs call/get uses the same `enabled` pattern as tools (`resources/read` throws `Resource ${uri} disabled`; `prompts/get` throws `Prompt ${name} disabled`).
- Docs (`docs/server.md` “Tools, resources, and prompts”) treat the three as separate registration APIs.

**Answer:** resources and prompts are independently registered and independently callable, regardless of which tools are registered. They are not gated by the tool map.

`[NOT FOUND]`: any SDK coupling that disables resources/prompts when a tool set is filtered.

## 5. Stateless mode

### Supported pattern

Constructor JSDoc on `StreamableHTTPServerTransport` / `WebStandardStreamableHTTPServerTransport` (installed d.ts and git tag):

```ts
const statelessTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
```

“If not provided, session management is disabled (stateless mode).”

Stateful vs stateless bullets in that JSDoc:

- Stateless: no Session ID in any responses; no session validation.
- Stateful: generate and include session ID; invalid IDs → 404; missing ID on non-init → 400.

SDK `docs/server.md` “Stateless vs stateful sessions” points at [`simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/examples/server/simpleStatelessStreamableHttp.ts).

### Per-request transport (required)

`handleRequest`:

```
if (!this.sessionIdGenerator && this._hasHandledRequest) {
  throw new Error('Stateless transport cannot be reused across requests. Create a new transport per request.');
}
```

A stateless transport may handle exactly one HTTP request.

### GET / DELETE

Spec 2025-11-25 Transports:

- GET: server MUST return `text/event-stream` **or** HTTP **405** if it does not offer a standalone SSE stream.
- DELETE: client SHOULD DELETE to terminate a session; server MAY answer **405** if it does not allow clients to terminate sessions.

Official stateless example (`simpleStatelessStreamableHttp.ts` at v1.29.0):

- POST `/mcp`: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `server.connect(transport)`, `transport.handleRequest(...)`.
- GET `/mcp` and DELETE `/mcp`: **405** JSON-RPC `-32000` `Method not allowed.` at the Express route, **without** calling the transport.

If GET/DELETE *are* forwarded to a stateless transport, `validateSession` is a no-op, so:

- GET: standalone SSE stream (406 if `Accept` lacks `text/event-stream`; otherwise 200 `text/event-stream`).
- DELETE: `onsessionclosed?.(this.sessionId)` then `close()`, HTTP 200 empty body.

The documented stateless **example** is 405 for GET and DELETE, not “transport handles them”.

### Close lifecycle

Same example, on the POST response:

```ts
res.on('close', () => {
  transport.close();
  server.close();
});
```

`WebStandardStreamableHTTPServerTransport.close()`: run each stream `cleanup()`, clear maps, call `onclose`.

`onsessionclosed` JSDoc (stateful / multi-node, not the stateless example): the callback fires on DELETE; “this is different from the transport closing”; when handling HTTP from multiple nodes “you might want to close each WebStandardStreamableHTTPServerTransport after a request is completed while still keeping the session open/running.”

`McpServer.connect` “assumes ownership of the Transport, replacing any callbacks that have already been set.” `McpServer.close()` closes the underlying `Server`.

## 6. SSE keep-alive

### Does 1.29.0 document `:\n\n` on the raw Node response?

**No.** `[NOT FOUND]` in SDK 1.29.0 server transport, `docs/server.md`, and the Streamable HTTP spec as an MCP keep-alive.

What exists:

- HTML SSE spec [§9.2.5 / §9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream): a line starting with `:` is a **comment** and is ignored. [§9.2.7 Authoring notes](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes): authors can include a comment line every ~15 seconds to protect against proxy idle timeouts. That is HTML, not MCP SDK documentation.
- SDK **client** `StreamableHTTPClientTransport` (`dist/esm/client/streamableHttp.js`): “Skip events with no data (priming events, keep-alives)” — empty `event.data` is skipped. It does not mention writing comments on `ServerResponse`.
- SDK **server** 1.29.0 `writeSSEEvent` writes only `event: message\n` plus optional `id:` plus `data: ${JSON.stringify(message)}\n\n` via `ReadableStreamDefaultController.enqueue`. Priming (only when `eventStore` is set and protocol ≥ `2025-11-25`) writes `id: …\ndata: \n\n` (empty data), not a `:` comment.
- Node adapter `StreamableHTTPServerTransport.handleRequest` gives the Web `Response` (including that `ReadableStream`) to `@hono/node-server` `getRequestListener`, which writes the stream onto the Node `ServerResponse`. The SDK does not expose a keep-alive hook on that raw `res`.

Version contrast (not this pin): SDK **1.30.0** later added “send SSE keep-alive comment frames from Streamable HTTP server transport” ([release notes](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0), PRs #2538 / #2547). That feature is **absent** from 1.29.0.

### What corrupts an SDK-managed SSE stream

From the 1.29.0 writer and client parser:

- SDK events are complete SSE frames of the form `event: message\ndata: <json>\n\n` enqueued on the stream controller. Extra `res.write` / `res.end` on the same Node `ServerResponse` is not part of that controller. Bytes interleaved into the middle of a frame (including a well-formed `:\n\n` inserted between `data:` and `\n\n`) break SSE line parsing.
- Client path `JSON.parse(event.data)` on `event.event === 'message'` (or missing event type). Non-JSON `data:` is `onerror`. Empty data is skipped (priming / keep-alive), not parsed.
- `writeSSEEvent` `try/catch`: enqueue failure calls `onerror` and returns `false`.
- Closing the controller (`cleanup`, `closeSSEStream`, `close()`, client cancel) ends the stream. After a JSON-RPC **response** is sent, `send()` calls `stream.cleanup()` (spec: server SHOULD terminate the SSE stream after the response).
- Second GET standalone stream while `_GET_stream` is mapped: **409** `Conflict: Only one SSE stream is allowed per session`.
- `send()` of a JSON-RPC response on the standalone GET stream throws: `Cannot send a response on a standalone SSE stream unless resuming a previous client request`.
- `send()` with no mapped request id throws `No connection established for request ID: …`.

`[NOT FOUND]` in 1.29.0: a documented, supported way for application code to write SSE comments onto an in-flight SDK Streamable HTTP SSE response.
)
