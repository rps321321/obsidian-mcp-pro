# Roadmap

What I'm working on and what's next. This is direction, not a promise — priorities
move as real usage and issues come in. Dates are deliberately absent; the order is
what matters.

## Now

- Hold the line on safety and correctness across the 41 tools: path boundaries,
  permissions, redacted logs, regression coverage on every fix.
- Performance baselines for 100 / 1,000 / 10,000-note vaults so scan-heavy changes
  can't silently regress (`npm run bench`).
- Keep tool descriptions and annotations honest against `docs/TOOL_AUTHORING.md`.

## Next

- Retrieval quality: hybrid lexical + vector search, better ranking, an evaluation
  harness over real and synthetic vault shapes.
- Workflow prompts: vault hygiene, daily/weekly review, link repair, research synthesis.
- Compatibility checks across major MCP clients (Claude Desktop, Claude Code, Cursor,
  VS Code, ChatGPT, HTTP clients) — a matrix that's actually maintained.
- Safe diagnostics: surface config, permissions, cache, and provider readiness without
  leaking vault contents.

## Later

- Deeper Obsidian format coverage (Bases, Canvas layout, Properties, tasks, embeds) as
  the formats stabilize and users ask for them.
- Local-first intelligence: offline embedding defaults, lightweight local rerankers,
  opt-in privacy-preserving vault-health metrics.
- A decision on plugin-facing integration points vs. staying a single focused server.

## Recently shipped

- See `CHANGELOG.md` for the running history.
