# Greptile Review Rules

Use these rules alongside normal code review. Prioritize high-signal logic, security, privacy, data, accessibility, migration, and architecture issues over cosmetic nitpicks.

## Migration Cleanup

When a project migrates from one provider or architecture to another, cleanup is part of the migration.

Examples:
- InstantDB to Supabase
- PayPal to Stripe
- Firebase to Postgres
- Clerk to Auth.js
- one analytics provider to another

Flag old imports, adapters, API routes, webhooks, generated clients, env vars, docs, tests, seed scripts, migrations, config, and packages that remain unintentionally.

## GDPR And Privacy By Design

Default to strict privacy-by-design:
- collect only necessary personal data
- avoid analytics/tracking/cookies unless explicitly required
- require opt-in before non-essential tracking
- avoid personal data in logs
- document third-party processors
- support access, correction, export, deletion, consent withdrawal, and retention behavior where user data exists
- flag high-risk processing such as health, financial, legal, children's data, precise location, biometrics, profiling, large-scale monitoring, AI processing of personal data, or file uploads containing personal data

## Accessibility And UI Quality

Target WCAG 2.2 AAA wherever feasible for user-facing UI.

Flag:
- overlapping, clipped, or overflowing text
- unstable sizing or layout shift
- missing labels or accessible names
- poor keyboard navigation
- invisible/unclear focus
- color-only state indicators
- weak contrast
- broken reflow/zoom/narrow viewport behavior
- missing empty/loading/error/disabled states
- motion that ignores reduced-motion preferences

## Security-Critical Surfaces

Pay extra attention to:
- auth and authorization
- admin actions
- file uploads
- payment flows
- webhooks
- database rules
- secrets/env handling
- AI tool calls or agentic actions

Flag frontend-only access checks, missing webhook signatures, missing idempotency, unsafe uploads, destructive actions without confirmation, unbounded queries, and secret leakage.

## Dependency And Config Hygiene

Prefer existing project conventions. Flag unnecessary dependencies, duplicated config, stale provider packages, conflicting test/lint/format tools, and env vars that no longer match current providers.
