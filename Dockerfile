FROM node:24-alpine

# ────── 构建/安装依赖时的代理（与现有 ob-mcp-pro-test 配置一致）──────
# 可选：构建/安装依赖代理（内网/代理环境按需启用，例如 --build-arg HTTP_PROXY=http://your-proxy:port）
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ENV http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY}

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存（依赖无变化时不重装）
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝全部源码并编译（src → dist/）
COPY . .
RUN npm run build

# ────── 清除代理（END）：最终镜像不带代理配置 ──────
ENV http_proxy= \
    https_proxy= \
    HTTP_PROXY= \
    HTTPS_PROXY= \
    no_proxy=*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3333

ENTRYPOINT ["/entrypoint.sh"]
