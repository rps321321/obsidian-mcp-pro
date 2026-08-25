#!/bin/sh
set -e

# 等待 Vault 挂载就绪（避免容器启动早于卷挂载）
if [ -n "$OBSIDIAN_VAULT_PATH" ]; then
  echo "[entrypoint] waiting for vault at $OBSIDIAN_VAULT_PATH"
  while [ ! -d "$OBSIDIAN_VAULT_PATH" ]; do
    sleep 1
  done
  echo "[entrypoint] vault ready: $OBSIDIAN_VAULT_PATH"
fi

# 编译产物在 build/（tsconfig.json outDir=./build，package.json main=./build/index.js）
# 参数（--transport=http 等）由 compose 的 command 提供
exec node build/index.js "$@"
