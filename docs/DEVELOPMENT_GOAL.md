# Professional Development and R&D Goal

> Operational rules live in [`AGENTS.md`](../AGENTS.md); the running objective the
> maintenance loop follows is [`docs/AGENT_GOAL.md`](AGENT_GOAL.md). This document is
> the long-form charter — the reasoning and the quarterly thinking behind those two.
> If they ever conflict, `AGENTS.md` wins.

## Goal

Maintain `obsidian-mcp-pro` as a trusted, production-quality MCP server for Obsidian vaults: safe enough for private knowledge bases, reliable enough for daily agent workflows, and ambitious enough to keep leading the Obsidian + MCP tool category through disciplined R&D.

The company-level objective is to turn the repository from a strong open-source utility into a sustainable product platform with clear ownership, repeatable release gates, measurable quality, and a research pipeline for new agent capabilities.

## Product Position

`obsidian-mcp-pro` gives AI assistants structured local access to Obsidian vaults through the Model Context Protocol. Its current surface includes:

- 41 MCP tools across read, write, section edits, tags, links, graph traversal, Canvas, Bases, attachments, semantic search, and prompts.
- Local-first file access with path-boundary checks, folder-scoped permissions, atomic writes, cache persistence, and HTTP transport hardening.
- Optional semantic search through Ollama or OpenAI embeddings.
- npm distribution, install tooling for common MCP clients, manual-only GitHub workflows, and a local Node 24 verification gate.

The professional maintenance goal is to preserve user trust while expanding capability. This repo should favor correctness, safety, observability, and compatibility over fast but fragile feature growth.

## Success Criteria

The project is professionally maintained when the following conditions are true every release cycle:

- Reliability: `npm run verify` passes locally on supported Node versions before merge or publish.
- Safety: destructive writes, vault-wide rewrites, HTTP access, attachment access, embedding calls, and permission boundaries have targeted regression coverage.
- Compatibility: released behavior is tested against current MCP SDK behavior, supported Node versions, and current Obsidian vault formats that the server claims to support.
- Product quality: every public tool has a high-quality title, description, annotations, bounded schema, friendly empty-state output, and useful error reporting.
- Operability: maintainers can diagnose failures from safe logs without leaking absolute vault paths, secrets, note content, or personal data.
- Release discipline: changelog, README, setup docs, package metadata, and npm package contents match the shipped behavior.
- R&D throughput: at least one measured experiment is active per quarter, with explicit hypotheses, fixtures, metrics, and a decision to ship, revise, or stop.

## Operating Principles

- Local vault trust comes first. A single bug can expose or corrupt a user's private knowledge base, so security and data integrity outrank convenience.
- APIs must be boring in the best way. Tool schemas, return formats, annotations, and error states should be predictable enough for agents to use without hidden knowledge.
- Backward compatibility is a product feature. Breaking changes require semver, migration notes, and client-facing examples.
- R&D must be measured. New capabilities should start with fixtures, metrics, and a kill criterion before they become permanent surface area.
- No silent provider drift. If embeddings, SDK APIs, transport behavior, package dependencies, or Obsidian formats change, verify against current docs or source before changing behavior.

## Workstreams

### 1. Core Maintenance

Keep the existing tool surface stable, tested, and easy to reason about.

Responsibilities:

- Preserve strict TypeScript settings and typed ESLint rules.
- Keep handler logic thin and shared behavior inside `src/lib/`.
- Add regression tests for every bug fix before or with the fix.
- Maintain cross-platform behavior for Windows, macOS, and Linux path semantics.
- Keep README, `docs/SETUP.md`, `docs/TOOL_AUTHORING.md`, and `CHANGELOG.md` aligned with implementation.

Key metrics:

- Zero known high-severity correctness or security regressions at release.
- The local verification gate is green on the supported Node baseline.
- No unreviewed public API changes in tool names, parameters, return shapes, resources, prompts, CLI flags, or env vars.

### 2. Security, Privacy, and Data Integrity

Protect private vault content and prevent destructive or confusing agent actions.

Responsibilities:

- Review every change touching `src/lib/vault.ts`, `src/lib/permissions.ts`, `src/http-server.ts`, attachment handling, semantic providers, install config writes, and vault-wide rewrite paths.
- Maintain tests for traversal, symlink escape, null bytes, path sanitization, cross-platform path ambiguity, destructive confirmation, HTTP token handling, CORS, rate limiting, and cache boundaries.
- Prevent secrets, absolute paths, raw note content, API keys, bearer tokens, and embedding payloads from leaking into logs or errors.
- Treat attachments and user-authored markdown as untrusted input.

Key metrics:

- `npm audit --audit-level=moderate` passes or has documented exceptions.
- Every security fix includes a regression test and changelog entry.
- No destructive tool path can run without the intended validation, permission checks, and confirmation behavior.

### 3. Tool Quality and Agent Ergonomics

Make tools easy for MCP clients and AI agents to choose correctly.

Responsibilities:

- Enforce the conventions in `docs/TOOL_AUTHORING.md`.
- Keep tool descriptions specific about behavior, return shape, intended use, edge cases, and related tools.
- Keep Zod schemas bounded with useful `.describe()` text.
- Return concise human-readable summaries that an agent can use directly.
- Preserve `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` accuracy.

Key metrics:

- New or changed tools meet the internal authoring checklist before merge.
- Third-party quality scoring remains at or above the project's current standard.
- Handler tests cover every tool through a real MCP client/server path.

### 4. Performance and Scale

Keep large vaults responsive without compromising correctness.

Responsibilities:

- Use bounded concurrency for vault-wide scans.
- Reuse the mtime cache and graph/cache structures where safe.
- Benchmark large-vault scenarios before expanding scan-heavy features.
- Avoid unbounded memory growth in embedding indexes, attachment listings, graph traversal, and Bases queries.
- Keep expensive features cancellable or progress-reporting where the MCP client supports it.

Key metrics:

- Defined performance fixtures for small, medium, and large vaults.
- No new vault-wide feature ships without max-result bounds or truncation behavior.
- Cache invalidation and concurrency behavior have targeted regression coverage.

### 5. Release Engineering and Distribution

Make releases predictable for users and maintainers.

Responsibilities:

- Maintain npm package contents: `build`, `README.md`, and `LICENSE`.
- Keep `prepublishOnly` meaningful and publish only from clean release artifacts.
- Use semantic versioning consistently for tool surface, CLI, env var, and default behavior changes.
- Test install flows for Claude Desktop, Cursor, VS Code/Copilot, and Claude Code whenever install logic changes.
- Keep release notes specific enough for agent-client maintainers to understand migrations.

Key metrics:

- Every release has a changelog entry and verified npm package contents.
- Breaking changes include migration examples.
- Installation smoke tests pass before publish.

### 6. R&D Pipeline

Run disciplined experiments that expand the product without destabilizing the core.

Candidate R&D tracks:

- Retrieval quality: better semantic search ranking, hybrid lexical + vector search, query expansion, note-neighborhood reranking, and evaluation fixtures built from synthetic and real-world vault patterns.
- Agent workflows: multi-step workflows for research synthesis, daily/weekly review, link repair, MOC building, writing assistance, and vault hygiene.
- Obsidian format coverage: deeper support for Bases, Canvas layout, Properties, embedded media, dataview-like patterns, tasks, and future Obsidian formats.
- Client compatibility: MCP client behavior across Claude Desktop, Claude Code, Cursor, VS Code, ChatGPT, and browser/http clients.
- Observability: safe diagnostics, trace IDs for tool calls, progress reporting, and user-facing debug bundles that avoid private content.
- Local-first intelligence: offline embedding defaults, lightweight local rerankers, opt-in local analytics for vault health, and privacy-preserving quality metrics.

Experiment template:

- Hypothesis: the user or maintainer problem being tested.
- Fixture: vault shape, notes, links, attachments, and expected outcomes.
- Metric: latency, recall, precision, token load, failed calls, user confirmation rate, or quality score.
- Safety review: data accessed, writes performed, logs emitted, and rollback path.
- Decision: ship, revise, defer, or stop.

## Quarterly Roadmap

### Quarter 1: Stabilize and Baseline

- Create performance fixtures for 100-note, 1,000-note, and 10,000-note vaults.
- Add a lightweight compatibility checklist for current MCP SDK behavior and major MCP clients.
- Audit tool descriptions and annotations against `docs/TOOL_AUTHORING.md`.
- Keep the package, manual workflows, and docs aligned on the supported Node 24 baseline.
- Add release-package smoke checks for npm contents and CLI entrypoint.

Exit criteria:

- Baseline quality, security, and performance metrics exist.
- Every public tool has a current authoring-quality review.
- Maintainers can reproduce release checks locally.

### Quarter 2: Retrieval and Workflow R&D

- Build an evaluation harness for semantic search and hybrid search.
- Compare Ollama and OpenAI embedding behavior on controlled note sets.
- Prototype workflow prompts for vault hygiene, daily review, and research synthesis.
- Measure whether graph-neighborhood context improves answer quality without excessive token load.

Exit criteria:

- One retrieval improvement is selected for production.
- R&D results are documented with fixtures, metrics, and a ship/no-ship decision.
- Any new tool or prompt has tests and quality-review coverage.

### Quarter 3: Client Compatibility and Operability

- Test HTTP transport and stdio behavior across major MCP clients.
- Add safe diagnostic output for configuration, permissions, cache state, and provider readiness.
- Improve troubleshooting docs with observed client-specific failures.
- Review logging and error messages for privacy and actionability.

Exit criteria:

- Client compatibility matrix exists and is maintained.
- Support issues can be triaged without exposing private vault data.
- HTTP and install flows have targeted smoke tests.

### Quarter 4: Platform Maturity

- Evaluate deeper Obsidian feature support based on user demand and format stability.
- Decide whether to introduce plugin-facing integration points or keep a single-server product.
- Review dependency health, MCP SDK migration needs, and release automation.
- Publish an annual reliability and R&D summary.

Exit criteria:

- Next-year product bets are based on evidence, not feature enthusiasm alone.
- Deprecated or low-value experiments are removed from the roadmap.
- Maintenance load is sustainable for the available team.

## Engineering Gates

Before merging code:

- Read relevant project docs and nearby implementation.
- Identify whether the change touches public tool/API behavior, security, privacy, data integrity, or release packaging.
- Add focused tests for the behavior being changed.
- Run the cheapest meaningful local verification first, then broader checks as risk increases.
- Update docs and changelog when user-visible behavior changes.

Before release:

- `npm ci`
- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- `npm audit --audit-level=moderate`
- npm package dry-run or equivalent package-content inspection
- Changelog and README review
- Install smoke test when CLI/install behavior changed

## Ownership Model

Suggested professional ownership:

- Product owner: prioritizes user workflows, R&D bets, compatibility, and release scope.
- Tech lead: owns architecture, code quality, dependency decisions, and public API consistency.
- Security reviewer: reviews vault boundaries, HTTP transport, permissions, destructive actions, attachments, secrets, and logging.
- QA/release owner: owns CI, test matrix, package verification, install smoke tests, and release notes.
- Support owner: tracks issues, reproductions, docs gaps, and user-reported client compatibility problems.

For a small team, one person may hold multiple roles, but every release should still pass through each lens.

## Definition of Done

A maintenance or R&D item is done only when:

- The behavior is implemented or the research decision is documented.
- Tests or fixtures cover the important success and failure paths.
- Security, privacy, performance, and compatibility risks have been reviewed at a depth proportional to the change.
- Documentation and changelog entries are updated when users or contributors need to know.
- Local verification passes, or any exception is documented with a follow-up owner.
