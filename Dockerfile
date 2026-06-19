FROM node:22-alpine AS builder

WORKDIR /app

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# 依赖层缓存
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY packages/protocol/package.json packages/protocol/
COPY packages/router/package.json packages/router/
COPY packages/audit/package.json packages/audit/
COPY packages/quota/package.json packages/quota/
COPY server/package.json server/

RUN pnpm install --frozen-lockfile

# 源码 + 构建
COPY packages/ packages/
COPY server/ server/

RUN pnpm build

# ============ Runtime 层 ============
FROM node:22-alpine AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# 仅生产依赖
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages packages/
COPY --from=builder /app/server server/

RUN pnpm install --frozen-lockfile --prod

# 数据目录
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 环境变量
ENV TENDER_PORT=8080
ENV TENDER_HOST=0.0.0.0
ENV TENDER_DB_PATH=/app/data/tender.sqlite
ENV TENDER_NODE_ENV=production

EXPOSE 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "server/dist/index.js"]
