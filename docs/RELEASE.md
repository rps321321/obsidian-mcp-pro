# Release

This repository publishes from a local, verified `master` checkout. GitHub
Actions stay manual-only; local `npm run verify` is the release gate.

## npm token setup

Use a granular npm access token rather than `npm login` on this machine.

Create the token on npmjs.com. npm documents access tokens as CLI/API
authentication that can publish packages, and granular tokens can be restricted
by package/scope, expiration, IP range, and write access:

- permission: read and write
- package access: `obsidian-mcp-pro` only, if available
- expiration: short enough to rotate on purpose
- 2FA: enable Bypass 2FA only when npm package/account policy would otherwise
  reject token publishing
- IP range: restrict if the current network is stable enough

References: [About access tokens](https://docs.npmjs.com/about-access-tokens/),
[Creating and viewing access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

Set it in the current shell:

```powershell
$env:NPM_TOKEN = "npm_xxx"
```

Or set it for future PowerShell sessions:

```powershell
[Environment]::SetEnvironmentVariable("NPM_TOKEN", "npm_xxx", "User")
```

Restart the terminal after setting a user-level variable. Never paste the token
into `.npmrc`, `.env`, shell history comments, GitHub comments, issues, PRs, or
agent-visible notes.

`NODE_AUTH_TOKEN` is accepted as a fallback name, but `NPM_TOKEN` is the primary
one used by this repository.

## Publish command

From a clean `master` checkout:

```powershell
node scripts\publish-npm-from-env.mjs --dry-run
node scripts\publish-npm-from-env.mjs
```

The helper:

- refuses to run outside `master`
- refuses to run with uncommitted changes
- runs `npm run verify`
- checks `npm whoami` with the token
- runs `npm publish --access public`
- writes only a temporary npm userconfig file containing `${NPM_TOKEN}`, then
  deletes it before exit

npm's `.npmrc` format supports environment-variable substitution, and npm's
`userconfig` setting can be supplied with `--userconfig`; the helper uses both
so auth config stays temporary.

References: [.npmrc](https://docs.npmjs.com/files/npmrc/),
[npm config](https://docs.npmjs.com/cli/using-npm/config/).

For a non-`latest` dist-tag:

```powershell
node scripts\publish-npm-from-env.mjs --tag next
```

After a successful publish, remove the variable from the current session if it is
not needed:

```powershell
Remove-Item Env:NPM_TOKEN
```
