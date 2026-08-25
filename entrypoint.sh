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

# 从源码构建的入口为 dist/index.js（WORKDIR=/app），
# 注意：package.json 的 build 脚本是 `tsc --outDir dist`，产物在 dist/ 而非 build/
# 参数（--transport=http 等）由 compose 的 command 提供
exec node dist/index.js "$@"
