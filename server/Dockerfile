# KompasCloud — образ бэкенда КОМПАС.ЗАПИСКИ.
#
# ADR-0003: отдельный стек, отдельные контейнеры (`zapiski-api`), отдельные
# тома. Ничего из работающего на хосте КОМПАС.Дневника не задействуется.

# ── Слой сборки ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Зависимости отдельным слоем: пересобираются только при изменении манифестов.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Прод-зависимости отдельно, чтобы devDependencies не уехали в рантайм.
RUN npm ci --omit=dev --no-audit --no-fund

# ── Рантайм ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# wget нужен HEALTHCHECK; tini — чтобы SIGTERM доходил до Node, а не терялся
# на PID 1, и завершение было мягким.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production \
    PORT=3100 \
    BLOB_ROOT=/data/blobs

WORKDIR /app

# Непривилегированный пользователь. Образ node:alpine уже содержит `node`
# (uid 1000) — заводить своего незачем.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./

# Том с зашифрованными блобами. Права — только владельцу.
RUN mkdir -p /data/blobs && chown -R node:node /data && chmod 700 /data/blobs

USER node

EXPOSE 3100
VOLUME ["/data"]

# Проба бьётся в тот же /health, что и nginx: проверяет базу и доступность тома.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
