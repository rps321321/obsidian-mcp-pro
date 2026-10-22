# Dependency security review

The 23 October 2026 dependency refresh keeps the declared package ranges unchanged. It resolves the 11 affected package records reported by `npm audit` against the previous lockfile. A clean scanner result describes that lockfile and advisory snapshot, not every application security property.

The resolved versions include MCP SDK 1.32.1, js-yaml 4.3.2, hono 4.13.13, proxy-addr 2.0.8, ip-address 10.7.4, fast-uri 3.1.9, brace-expansion 5.0.12, source-map-js 1.2.2, Vite 8.3.5, and Vitest 4.1.12. The ip-address version proposed in #295, 10.7.3, is affected by a newer advisory, so that version is insufficient for the refreshed audit gate.

## MCP validation budget

[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) describes memory exhaustion during validation of tool arguments. SDK 1.32.0 adds `maxToolInputElements`, but leaves it disabled by default. The advisory also requires a request-byte limit sized for the application. An SDK version update alone does not configure either protection.

The current application has these boundaries:

- `startHttpServer` authenticates `/mcp` requests before it reads their bodies or dispatches to the SDK.
- Its own JSON parser rejects bodies above 4 MiB, including streamed bodies. Because this parser supplies the parsed body to the SDK, a transport-only parser setting would not replace this check.
- Tool argument schemas use bounded strings, numbers, booleans, and enums. Frontmatter payloads are bounded JSON strings, rather than SDK record schemas. Some write tools accept one million content characters.
- `buildMcpServer` does not set `maxToolInputElements`. Valid bearer tokens therefore do not have this independent argument-count budget.

These observations reduce or constrain some exposure, but do not establish complete mitigation. Authentication does not make every token holder trustworthy. Scalar schemas also do not substitute for a measured limit on hostile argument objects.

Before completing #311, select and test an argument-count budget against the largest legitimate tool call. Evaluate the 4 MiB parser cap against supported content sizes and JSON escaping before changing it. Verify over-budget rejection and subsequent server responsiveness through the installed package. Keep that behavior change separate from the lockfile refresh.
