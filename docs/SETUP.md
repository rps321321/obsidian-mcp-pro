# Setup Guide

## Claude Desktop

Add to your `claude_desktop_config.json`:

### Auto-detect vault
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"]
    }
  }
}
```

### Specify vault path
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### Config file locations
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Claude Code

```bash
claude mcp add obsidian-mcp-pro -- npx -y obsidian-mcp-pro
```

With specific vault:
```bash
OBSIDIAN_VAULT_PATH="/path/to/vault" claude mcp add obsidian-mcp-pro -- npx -y obsidian-mcp-pro
```

## Cursor

Add to `.cursor/mcp.json` in your project:
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"]
    }
  }
}
```

## VS Code (Copilot)

Add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"]
    }
  }
}
```

## Windsurf

Add to `~/.windsurf/mcp.json`:
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"]
    }
  }
}
```

## Troubleshooting

### Vault not detected
Set the vault path explicitly:
```
OBSIDIAN_VAULT_PATH="/path/to/vault"
```

### Multiple vaults
Select by name:
```
OBSIDIAN_VAULT_NAME="My Vault"
```

### Node.js version
Requires Node.js >= 18.17.0. Check with `node --version`.
