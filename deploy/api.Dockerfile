# Образ KompasCloud API (ADR-0003: Node 22 + Fastify).
#
# Контекст сборки — каталог server/ (см. deploy/docker-compose.yml).
# Файл лежит в deploy/, а не в server/, потому что server/ принадлежит
# команде бэкенда: деплойные артефакты держим у себя, чтобы не редактировать
# чужой каталог. Если в server/ появится собственный Dockerfile — переключите
# `dockerfile:` в compose на него и удалите этот файл.

# ─────────────────────────────────────────────────────────────────────────────
# Сборка
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Слой зависимостей отдельно от исходников: пересобирается только при
# изменении lock-файла.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Рантайм
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# src/ и migrations/ нужны в рантайме: `npm run migrate` исполняет
# src/db/migrate.ts напрямую (--experimental-strip-types) и читает .sql
# из migrations/.
COPY src ./src
COPY migrations ./migrations
# legal/ читается НА КАЖДЫЙ ЗАПРОС `/terms` и `/privacy`: тексты нарочно не
# вкомпилированы, чтобы правку можно было выкатить без пересборки клиентов.
# Без этой строки маршруты в коде есть, а документа на диске нет — и страница
# согласия отвечает 404. Так и было: nginx довёл запрос до API, а API его не
# нашёл.
COPY legal ./legal

# Непривилегированный пользователь. BLOB_ROOT создаём и отдаём ему ДО
# объявления тома: пустой named volume наследует владельца каталога-точки
# монтирования при первом создании.
RUN addgroup -S zapiski && adduser -S -G zapiski zapiski \
 && mkdir -p /data/blobs \
 && chown -R zapiski:zapiski /data

USER zapiski

# ADR-0003 §2: только 3100. Порт 3000 занят КОМПАС.Дневником.
EXPOSE 3100

# Healthcheck описан в deploy/docker-compose.yml, чтобы правило жило рядом
# с оркестрацией, а не было зашито в образ.
CMD ["node", "dist/index.js"]
