# Dependency security review

The initial 23 October 2026 dependency refresh kept the declared package ranges unchanged. The 4.1.1 correction below raises the MCP SDK minimum. It resolves the 11 affected package records reported by `npm audit` against the previous lockfile. A clean scanner result describes that lockfile and advisory snapshot, not every application security property.

The resolved versions include MCP SDK 1.32.1, js-yaml 4.3.2, hono 4.13.13, proxy-addr 2.0.8, ip-address 10.7.4, fast-uri 3.1.9, brace-expansion 5.0.12, source-map-js 1.2.2, Vite 8.3.5, and Vitest 4.1.12. The ip-address version proposed in #295, 10.7.3, is affected by a newer advisory, so that version is insufficient for the refreshed audit gate.

## MCP validation budget

[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) describes memory exhaustion during validation of tool arguments. SDK 1.32.0 adds `maxToolInputElements`, but leaves it disabled by default. The advisory also requires a request-byte limit sized for the application. An SDK version update alone does not configure either protection.

The current application has these boundaries:

- `startHttpServer` authenticates `/mcp` requests before it reads their bodies or dispatches to the SDK.
- Its own JSON parser rejects bodies above 4 MiB, including streamed bodies. Because this parser supplies the parsed body to the SDK, a transport-only parser setting would not replace this check.
- Tool argument schemas use bounded strings, numbers, booleans, and enums. Frontmatter payloads are bounded JSON strings, rather than SDK record schemas. Some write tools accept one million content characters.
- `buildMcpServer` sets `maxToolInputElements: 16` for both HTTP sessions and stdio. The SDK counts each object key and array entry recursively before tool-schema validation. Strings count as scalar values regardless of their character length. Calls above the budget receive an `isError: true` tool result before the handler runs.

The 41 advertised tools currently accept scalar fields only. The largest schema is `add_canvas_node`, with eight fields; `add_canvas_edge` and `replace_in_note` each have six. A budget of 16 leaves room above the largest supported call while rejecting extra nested objects that schema validation previously discarded. The protocol regressions exercise all eight canvas-node fields, exactly 16 counted elements, rejection at 17 and 100,002 elements, and a successful subsequent call. A schema census resolves local references and unions and fails on unbounded or unsupported structures, so future tool additions must revisit the budget if their supported inputs outgrow it.

This is a security restriction on extra fields outside the advertised tool schemas. It does not change any documented tool parameter, result shape, or valid scalar payload limit, and is compatible with the prepared 4.1.0 release. Both protocols retain support for one million content characters and 100,000 frontmatter JSON-string characters in a call. The budget is an argument-structure limit, not a heap-size guarantee or a byte limit.

The HTTP parser cap remains 4 MiB. One million characters can approach 4 MiB in UTF-8 before JSON framing, and JSON escaping can make a schema-valid string exceed the cap. HTTP clients must satisfy both limits; they may need smaller content chunks. Stdio retains the SDK transport's separate default 10 MB read-buffer limit. Authentication still runs before HTTP body parsing: an unauthenticated over-size request receives 401, while an authenticated one receives 413. Authentication alone does not make every token holder trustworthy.

Before completing #311, run the release gate and verify this rejection and recovery through the packaged server. A passing source test or clean audit does not establish a published, consumable release.

## Consumer SDK resolution correction in 4.1.1

The published 4.1.0 package declared SDK `^1.29.0`, although its development lockfile resolved 1.32.1. A consumer retaining SDK 1.29.0 could satisfy that range and silently ignore `maxToolInputElements`. A bounded reproduction installed registry 4.1.0 with an exact root SDK 1.29.0: `append_to_note` with 17 extra scalar fields (19 total) succeeded and changed the fixture. This demonstrates missing pre-dispatch enforcement without an exhaustion payload.

Version 4.1.1 requires SDK `^1.32.1`. The packed-consumer check first installs an exact root SDK 1.29.0, then installs the production tarball. It verifies that the consumer retains its old dependency while the core resolves a compatible nested SDK. Actual HTTP and stdio calls reject 17 total fields without changing a note, accept 16, and successfully read afterward. This tests the installed dependency graph and behavior rather than relying on the repository lockfile or a version assertion. No tool schema or public API changes are required.
