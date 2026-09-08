#!/bin/sh
set -e

# Wait for the vault mount to be ready (avoids starting before the volume mounts)
if [ -n "$OBSIDIAN_VAULT_PATH" ]; then
  echo "[entrypoint] waiting for vault at $OBSIDIAN_VAULT_PATH"
  while [ ! -d "$OBSIDIAN_VAULT_PATH" ]; do
    sleep 1
  done
  echo "[entrypoint] vault ready: $OBSIDIAN_VAULT_PATH"
fi

# Build output lives in build/ (tsconfig.json outDir=./build, package.json main=./build/index.js).
# CLI args (e.g. --transport=http) are provided by the compose command.
exec node build/index.js "$@"
