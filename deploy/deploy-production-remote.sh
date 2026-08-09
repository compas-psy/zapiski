#!/usr/bin/env bash
#
# Поднимает API-стек КОМПАС.ЗАПИСКИ. Исполняется НА СЕРВЕРЕ cmpas.ru,
# запускается из .github/workflows/deploy-zapiski.yml после `git reset --hard`.
#
# Что этот скрипт НЕ делает:
#   * не собирает PWA — фронт собирается на раннере GitHub Actions и приезжает
#     rsync'ом прямо в /var/www/zapiski.cmpas.ru;
#   * не трогает /var/www/cmpas.ru, его compose-стек, его контейнеры, его тома
#     и его базу (ADR-0003 §3, §4) — см. защиту guard_not_cmpas ниже;
#   * не трогает nginx. Конфиг ставится один раз провижном
#     (.github/workflows/provision-zapiski.yml), обычный деплой к веб-серверу
#     не подходит вообще.
#
# Все ИЗМЕНЯЮЩИЕ docker-команды здесь адресованы либо compose-проекту
# `zapiski`, либо контейнерам с именами zapiski-*. Контейнер Дневника
# упоминается ровно один раз, в самом конце, и только в `docker inspect` —
# чтобы записать в лог, что он как работал, так и работает.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/deploy/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/deploy/.env"
PROJECT="zapiski"
API_CONTAINER="zapiski-api"
DB_CONTAINER="zapiski-postgres"

log()  { printf '[zapiski-deploy] %s\n' "$*"; }
fail() { printf '[zapiski-deploy] ОШИБКА: %s\n' "$*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# 0. Защита от запуска не оттуда
# ─────────────────────────────────────────────────────────────────────────────
#
# ADR-0003 §3: «`docker compose down` в одном каталоге не может задеть другой».
# Проверка страхует от человеческой ошибки — скопировали скрипт не туда,
# перепутали каталог в ssh-сессии.
guard_not_cmpas() {
  case "${REPO_ROOT}" in
    /var/www/cmpas.ru|/var/www/cmpas.ru/*|/var/www/moments.cmpas.ru|/var/www/moments.cmpas.ru/*)
      fail "скрипт запущен из ${REPO_ROOT} — это каталог КОМПАС.Дневника. Ожидается /var/www/zapiski."
      ;;
  esac
  [ -f "${COMPOSE_FILE}" ] || fail "не найден ${COMPOSE_FILE}"
}

# Обёртка: каждая compose-команда явно привязана к нашему проекту и файлу.
dc() { docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}" "$@"; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. deploy/.env — единственное место с секретами на сервере
# ─────────────────────────────────────────────────────────────────────────────

upsert_env() {
  local key="$1" value="$2" escaped
  escaped=$(printf '%s' "${value}" | sed 's/[&|]/\\&/g')
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

# Ставит значение, только если ключа ещё нет или он пуст. Уже заданное
# человеком руками не перетирается никогда.
ensure_env() {
  local key="$1" default_value="$2" current
  current=$(grep "^${key}=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)
  if [ -z "${current}" ]; then
    upsert_env "${key}" "${default_value}"
    log "deploy/.env: ${key} проставлен значением по умолчанию."
  fi
}

prepare_env() {
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  # Пароль БД генерируется один раз и живёт в deploy/.env.
  # ВАЖНО: том zapiski_db_data помнит пароль, с которым была инициализирована
  # база. Если удалить deploy/.env, но оставить том — новый пароль не подойдёт
  # (лечится ALTER USER внутри контейнера, см. deploy/SETUP.md).
  # Hex — чтобы значение было безопасно вставлять в DATABASE_URL без
  # url-экранирования.
  local db_password
  db_password=$(grep '^ZAPISKI_DB_PASSWORD=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)
  if [ -z "${db_password}" ]; then
    upsert_env ZAPISKI_DB_PASSWORD "$(openssl rand -hex 32)"
    log 'ZAPISKI_DB_PASSWORD сгенерирован.'
  fi

  # ADR-0003 §7: почта — через существующий postfix Дневника по адресу
  # docker0. Значения переопределяемы вручную в deploy/.env.
  ensure_env EMAIL_SERVER_HOST '172.17.0.1'
  ensure_env EMAIL_SERVER_PORT '25'
  ensure_env EMAIL_FROM 'zapiski@cmpas.ru'

  # Секреты внешних сервисов приходят из окружения ssh-сессии (workflow
  # передаёт их из GitHub Secrets). Пустые не записываем, чтобы не затирать
  # уже проставленное руками.
  local key value
  for key in YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET; do
    value="${!key:-}"
    if [ -n "${value}" ]; then
      upsert_env "${key}" "${value}"
      log "deploy/.env: ${key} обновлён из секретов CI."
    fi
  done

  # HS256-секрет для access-JWT (server/src/config/env.ts требует min 32
  # символа). Генерируем сами, если человек не задал свой. Перегенерация
  # разлогинит всех — поэтому только при отсутствии.
  local auth_secret
  auth_secret=$(grep '^AUTH_SECRET=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)
  if [ -z "${auth_secret}" ]; then
    upsert_env AUTH_SECRET "$(openssl rand -hex 32)"
    log 'AUTH_SECRET сгенерирован.'
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Ожидания
# ─────────────────────────────────────────────────────────────────────────────

wait_for_postgres() {
  local retries=45
  log 'Ждём готовности zapiski-postgres...'
  until docker exec "${DB_CONTAINER}" pg_isready -U zapiski -d zapiski >/dev/null 2>&1; do
    retries=$((retries - 1))
    if [ "${retries}" -le 0 ]; then
      log 'база не поднялась, логи:'
      docker logs "${DB_CONTAINER}" --tail 200 2>&1 || true
      return 1
    fi
    sleep 2
  done
  log 'zapiski-postgres готов.'
}

container_state() {
  docker inspect -f '{{ .State.Status }}' "$1" 2>/dev/null || echo 'missing'
}

health_state() {
  docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}none{{ end }}' \
    "$1" 2>/dev/null || echo 'missing'
}

wait_for_api_running() {
  local retries=30
  until [ "$(container_state "${API_CONTAINER}")" = 'running' ]; do
    retries=$((retries - 1))
    [ "${retries}" -le 0 ] && return 1
    sleep 2
  done
}

# Healthcheck описан в deploy/docker-compose.yml. Здесь только ждём его вердикт.
wait_for_api_health() {
  local retries=60 status
  log 'Ждём healthcheck zapiski-api...'
  while true; do
    status="$(health_state "${API_CONTAINER}")"
    case "${status}" in
      healthy) log 'zapiski-api здоров.'; return 0 ;;
      missing) log 'контейнер zapiski-api исчез.'; return 1 ;;
      none)
        # Healthcheck по какой-то причине не объявлен — пробуем сами.
        if curl -fsS --max-time 5 http://127.0.0.1:3100/api/v1/health >/dev/null 2>&1; then
          log 'zapiski-api отвечает на /api/v1/health.'
          return 0
        fi
        ;;
    esac
    retries=$((retries - 1))
    if [ "${retries}" -le 0 ]; then
      log "healthcheck не сошёлся, последний статус: ${status}"
      return 1
    fi
    sleep 2
  done
}

dump_diagnostics() {
  log '──────── диагностика стека zapiski ────────'
  dc ps 2>&1 || true
  log '──────── docker logs zapiski-api ────────'
  docker logs "${API_CONTAINER}" --tail 300 2>&1 || true
  log '──────── docker logs zapiski-postgres ────────'
  docker logs "${DB_CONTAINER}" --tail 100 2>&1 || true
  log '───────────────────────────────────────────'
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Собственно деплой
# ─────────────────────────────────────────────────────────────────────────────

main() {
  guard_not_cmpas
  log "Каталог: ${REPO_ROOT}"

  prepare_env

  log 'Сборка и запуск стека zapiski...'
  # --remove-orphans тоже ограничен проектом `zapiski`: compose удаляет только
  # контейнеры со своей меткой com.docker.compose.project=zapiski. Контейнеры
  # Дневника помечены другим проектом и для этой команды невидимы.
  dc up -d --build --remove-orphans

  wait_for_postgres || { dump_diagnostics; fail 'PostgreSQL ЗАПИСОК не поднялся.'; }

  # Миграции идут ДО ожидания healthcheck намеренно: если схема ещё не
  # накатана, API имеет полное право не отвечать 200 на /api/v1/health,
  # и ждать его здоровья в этот момент бессмысленно.
  wait_for_api_running || { dump_diagnostics; fail 'Контейнер zapiski-api не запустился.'; }

  log 'Миграции БД...'
  # --if-present: пока в server/package.json нет скрипта migrate, шаг просто
  # ничего не делает. Настоящая ошибка миграции роняет деплой как положено.
  if ! dc exec -T api npm run --if-present migrate; then
    dump_diagnostics
    fail 'Миграции БД не прошли.'
  fi

  if ! wait_for_api_health; then
    dump_diagnostics
    fail 'API ЗАПИСОК не стал здоровым. Стек оставлен как есть для разбора; КОМПАС.Дневник не затронут.'
  fi

  log 'Готово. Состояние стека:'
  dc ps 2>&1 || true

  # Только чтение: фиксируем в логе, что Дневник как работал, так и работает.
  # Никаких действий над ним не выполняется — даже если он лежит, это не наш
  # деплой его уронил и не нам его чинить отсюда.
  log "Контроль изоляции — контейнер Дневника cmpas-app: $(container_state cmpas-app) (мы его не трогали)"
}

main "$@"
