# Continuous Integration

Pull requests and pushes to `master` run the GitHub Actions Node 24 quality gate defined in `.github/workflows/ci.yml`.

The required deterministic checks are:

- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run pack:check`

The workflow uses read-only repository permissions and cancels superseded runs. The quality job has a 20-minute timeout.

After the quality job passes, independent Node 24 jobs on Ubuntu, Windows and macOS run `node scripts/check-packed-consumer.mjs`, each with a 15-minute timeout. The probe installs the actual production tarball in an owned temporary consumer, retains an old direct SDK dependency, and verifies the core resolves its own compatible SDK. HTTP and stdio must reject over-budget calls before mutation, allow the boundary call, and recover. The probe also checks the installed CLI, link targets, concurrent sessions, reconnect, shutdown and supported directory aliases. POSIX mode checks run on Linux and macOS. These are installed-consumer checks, not the complete unit suite on every platform.

## Local and release verification

`npm run verify` remains the full local/prepublish maintenance gate. In addition to the deterministic code/package checks, it runs `npm audit --audit-level=moderate`.

The audit is intentionally not part of required pull-request CI because npm advisory data can change independently of the proposed code. It must still be clean at release time; `prepublishOnly` runs `npm run verify` before publication.

`npm run verify:full` adds license checking and dogfood validation for deeper release/maintenance checks.
