# Repository agent setup

Public engineering workflow configuration lives under `docs/agents/`.

Maintainer operating rules are local-only. If `.agent/internal/AGENTS.md` exists,
read it before autonomous maintenance, release, research, or product-strategy work.
If it is absent, work as a normal contributor and do not run the unattended
maintenance loop or publish releases.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues; external pull requests are also a triage
surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-document layout. See
`docs/agents/domain.md`.
