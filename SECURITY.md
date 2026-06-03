# Security Policy

obsidian-mcp-pro gives AI assistants local access to Obsidian vaults, which often
hold private notes. I take reports about that access seriously.

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private
reporting instead: go to the **Security** tab → **Report a vulnerability**. That
keeps the details private until there's a fix.

Useful things to include:

- what an attacker can do, and the impact (vault read, write, path escape, leak)
- the version, OS, and transport (stdio or HTTP) you tested
- steps or a minimal vault/config that reproduces it

I'll confirm I've seen the report, work on a fix, and credit you in the release notes
if you'd like. If a report turns out to be a non-issue I'll explain why rather than
leave you hanging.

## Supported versions

Fixes land on the latest `2.x` release on npm. Older majors aren't patched — upgrade
to pick up security fixes.

## What I care about most

- path-boundary escape (traversal, symlinks, null bytes) outside the configured vault
- folder-permission bypass on read or write
- destructive or vault-wide operations running without their confirmation
- secrets, API keys, bearer tokens, absolute paths, or note content leaking into logs
  or error messages
- HTTP transport: token handling, CORS, rate limiting

## Scope

Treat vault markdown, attachments, and anything fed through tool arguments as
untrusted input — that's the threat model this project is built around. Bugs in your
own MCP client or in Obsidian itself are out of scope here, but tell me anyway if the
boundary is unclear and I'll help route it.
