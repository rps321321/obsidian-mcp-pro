# Continuous Integration

Pull requests and pushes to `master` run the GitHub Actions Node 24 quality gate defined in `.github/workflows/ci.yml`.

The required deterministic checks are:

- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run pack:check`

The workflow uses read-only repository permissions, cancels superseded runs, and has a 20-minute job timeout.

## Local and release verification

`npm run verify` remains the full local/prepublish maintenance gate. In addition to the deterministic code/package checks, it runs `npm audit --audit-level=moderate`.

The audit is intentionally not part of required pull-request CI because npm advisory data can change independently of the proposed code. It must still be clean at release time; `prepublishOnly` runs `npm run verify` before publication.

`npm run verify:full` adds license checking and dogfood validation for deeper release/maintenance checks.
