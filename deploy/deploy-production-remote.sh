#!/usr/bin/env bash
#
# Поднимает API-стек КОМПАС.ЗАПИСКИ. Исполняется НА СЕРВЕРЕ cmpas.ru,
# запускается из .github/workflows/deploy-zapiski.yml после того, как каталоги
# deploy/ и server/ доставлены в /var/www/zapiski rsync'ом с раннера.
# Каталог /var/www/zapiski НЕ является git-репозиторием — на сервере нет ни
# доступа к GitHub, ни .git; полагаться на git здесь нельзя.
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

# Отдельная проверка окружения: без неё первая же непонятная ошибка выглядела бы
# как падение сборки образа, хотя причина — отсутствующий compose v2 или
# недоступный докер-демон.
check_prereqs() {
  command -v docker >/dev/null 2>&1 || fail 'на сервере нет docker.'
  docker info >/dev/null 2>&1 || fail 'докер-демон недоступен (нет прав у пользователя или демон не запущен).'
  docker compose version >/dev/null 2>&1 \
    || fail 'нет docker compose v2 (плагин compose). Скрипт рассчитан на `docker compose`, а не `docker-compose`.'

  # curl нужен финальной проверке снаружи (verify_public). Без него деплой
  # прошёл бы «успешно», ни разу не постучавшись в собственный сайт.
  command -v curl >/dev/null 2>&1 \
    || fail 'на сервере нет curl — им проверяется, что сайт отвечает снаружи.'

  # Каталог обновлений монтируется в контейнер API только на чтение
  # (deploy/docker-compose.yml). Если его нет, docker создал бы его сам от
  # root, и nginx потом не смог бы отдавать оттуда файлы. Создаём явно.
  local updates_dir='/var/www/zapiski.cmpas.ru/updates'
  [ -d "${updates_dir}" ] || {
    mkdir -p "${updates_dir}"
    log "создан ${updates_dir} (точка монтирования UPDATES_MANIFEST_PATH)."
  }
}

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
  # Адрес релея. `host.docker.internal` — шлюз ТОЙ сети, в которой стоит
  # контейнер (см. `extra_hosts` в compose).
  #
  # Прежнее значение `172.17.0.1` — шлюз docker0, то есть ЧУЖОЙ сети: API
  # работает в `zapiski_net`, оттуда этот адрес не маршрутизируется, и почта
  # молча не работала. Это было НАШЕ умолчание, а не выбор человека, поэтому
  # оно переписывается; всё остальное, что стоит в deploy/.env, не трогаем.
  if [ "$(grep '^EMAIL_SERVER_HOST=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || true)" = '172.17.0.1' ]; then
    upsert_env EMAIL_SERVER_HOST 'host.docker.internal'
    log 'deploy/.env: EMAIL_SERVER_HOST переведён с шлюза docker0 на host.docker.internal.'
  fi
  ensure_env EMAIL_SERVER_HOST 'host.docker.internal'
  ensure_env EMAIL_SERVER_PORT '25'
  # Релей на этой же машине — см. пояснение в deploy/docker-compose.yml.
  # Зовётся он `host.docker.internal`; сертификата на такое имя не существует,
  # поэтому строгая проверка превращала живой postfix в `mail: fail`.
  ensure_env EMAIL_SERVER_LOCAL_RELAY 'true'
  ensure_env EMAIL_FROM 'zapiski@cmpas.ru'

  # Секреты внешних сервисов приходят из окружения ssh-сессии (workflow
  # передаёт их из GitHub Secrets). Пустые не записываем, чтобы не затирать
  # уже проставленное руками.
  local key value
  for key in YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET TINKOFF_TERMINAL_KEY TINKOFF_PASSWORD; do
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

# Может ли API отправить письмо со ссылкой для входа.
#
# Проверяем ИЗ КОНТЕЙНЕРА API, а не с хоста: адрес релея у контейнера свой,
# и «с хоста видно» ничего не доказывает.
#
# Проверяем ТЕМ ЖЕ КОДОМ, которым уходит письмо, — nodemailer'ом и с
# настройками из окружения самого контейнера. Прежняя проверка читала одно
# приветствие SMTP и на «220» рапортовала «письма уйдут». Она соврала:
# приветствие приходило, а `mail` в health держался `fail`, потому что
# nodemailer обрывался ПОЗЖЕ — на STARTTLS, где сертификата на имя
# `host.docker.internal` не существует. Сторож, который смотрит не туда,
# где ломается, хуже отсутствующего: он закрывает вопрос ложным «всё хорошо».
#
# Деплой не валим никогда: почта не мешает работать с заметками, а падение
# выкладки из-за чужого postfix'а было бы хуже самой поломки.
check_mail_relay() {
  local verdict

  verdict="$(docker exec "${API_CONTAINER}" node -e '
    const nodemailer = require("nodemailer");
    const host = process.env.SMTP_HOST || "localhost";
    const port = Number(process.env.SMTP_PORT || 25);
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: String(process.env.SMTP_SECURE) === "true",
      ...(String(process.env.SMTP_LOCAL_RELAY) === "true"
        ? { opportunisticTLS: true, tls: { rejectUnauthorized: false } }
        : {}),
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });
    const say = (line) => console.log(String(line).replace(/\s+/g, " ").slice(0, 300));
    transport.verify().then(
      () => { say(`ok ${host}:${port}`); process.exit(0); },
      (error) => {
        const code = error && error.code ? error.code : "";
        const text = error && error.message ? error.message : String(error);
        say(`fail ${host}:${port} ${code} ${text}`);
        process.exit(1);
      },
    );
  ' 2>&1 || true)"

  case "${verdict}" in
    ok\ *)
      log "Почта: ${verdict#ok } принимает письма — ссылка для входа уйдёт."
      ;;
    fail\ *)
      log "ВНИМАНИЕ: почта не работает — ${verdict#fail }"
      log '  Вход по почте не работает: приложение скажет «письмо ушло», а письма не будет.'
      log '  Проверьте postfix и EMAIL_SERVER_HOST/EMAIL_SERVER_PORT в deploy/.env.'
      ;;
    *)
      log "ВНИМАНИЕ: проверка почты не дала ответа: ${verdict:-(молчание)}"
      ;;
  esac
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

# Диагностика печатается ровно один раз за запуск: явные ветки ошибок зовут её
# сами, а на всё непредусмотренное её позовёт обработчик ERR ниже. Без флага
# лог падения дублировался бы.
DIAG_DUMPED=0

dump_diagnostics() {
  if [ "${DIAG_DUMPED}" -eq 1 ]; then
    return 0
  fi
  DIAG_DUMPED=1
  log '──────── диагностика стека zapiski ────────'
  dc ps 2>&1 || true
  log '──────── docker logs zapiski-api ────────'
  docker logs "${API_CONTAINER}" --tail 300 2>&1 || true
  log '──────── docker logs zapiski-postgres ────────'
  docker logs "${DB_CONTAINER}" --tail 100 2>&1 || true
  log '───────────────────────────────────────────'
}

# Раньше диагностика снималась только в заранее предусмотренных ветках
# (база не поднялась, контейнер не стартовал, healthcheck не сошёлся). Самый
# частый в жизни случай — падение `docker compose up --build` на сборке образа —
# под них не попадал: `set -e` обрывал скрипт молча, и в логе CI оставалась
# голая строка про ненулевой код возврата. Теперь ЛЮБОЙ незапланированный сбой
# оставляет после себя ps и логи обоих контейнеров.
on_unexpected_error() {
  local code=$? line="${1:-?}"
  log "НЕОЖИДАННЫЙ сбой: команда на строке ${line} завершилась с кодом ${code}."
  dump_diagnostics
  log 'Стек zapiski оставлен как есть для разбора; КОМПАС.Дневник не затронут.'
  exit "${code}"
}
trap 'on_unexpected_error "${LINENO}"' ERR

# ─────────────────────────────────────────────────────────────────────────────
# 3. Собственно деплой
# ─────────────────────────────────────────────────────────────────────────────

# Миграции идут через `exec` в уже поднятый контейнер. У api стоит
# restart: always, поэтому сразу после `up` он может оказаться в состоянии
# restarting — тогда `exec` возвращает «container is restarting», и это не
# ошибка миграции, а гонка. Поэтому несколько попыток, а не одна.
run_migrations() {
  local retries=5 out
  while true; do
    if out="$(dc exec -T api npm run --if-present migrate 2>&1)"; then
      printf '%s\n' "${out}"
      return 0
    fi
    retries=$((retries - 1))
    if [ "${retries}" -le 0 ]; then
      printf '%s\n' "${out}"
      return 1
    fi
    log 'миграции: контейнер ещё не готов принимать exec, повтор через 3с...'
    sleep 3
  done
}

# Финальная проверка «снаружи», через настоящий vhost и настоящий TLS.
# Здоровый контейнер ещё не означает работающий сайт: healthcheck бьётся в
# 127.0.0.1:3100 ВНУТРИ контейнера и ничего не знает ни про nginx, ни про
# сертификат, ни про то, доехала ли статика в docroot. Проверяем обе половины
# ровно так, как их увидит браузер.
PUBLIC_URL='https://zapiski.cmpas.ru'

# Про `|| true` вместо `|| echo '000'` ниже: при неудаче curl печатает «000»
# сам, и второй источник того же значения давал «000000» — строку, которая не
# равна ни одному ожидаемому коду. Здесь это ещё сходило с рук (всё, что не
# начинается с двойки, считается провалом), но та же связка в проверке TLS
# провижна пропускала ровно тот случай, ради которого написана.
verify_public() {
  local retries=10 code
  log "Проверяем ${PUBLIC_URL}/api/v1/health через nginx..."
  while true; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      "${PUBLIC_URL}/api/v1/health" 2>/dev/null || true)"
    case "${code}" in
      2*) log "API снаружи отвечает ${code}."; break ;;
    esac
    retries=$((retries - 1))
    if [ "${retries}" -le 0 ]; then
      log "API снаружи не отвечает: последний код ${code}."
      return 1
    fi
    sleep 3
  done

  # Статика. Пустой docroot или сломанный SPA-фолбэк дают 403/404 — деплой
  # веба при этом считался бы успешным, хотя сайт не открывается.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    "${PUBLIC_URL}/" 2>/dev/null || true)"
  case "${code}" in
    2*) log "Статика PWA отдаётся (${code})." ;;
    *)  log "Статика PWA НЕ отдаётся: код ${code}."; return 1 ;;
  esac

  verify_documents
  verify_app_origin
}

# Приложения обязаны иметь право обратиться к API.
#
# Окно Tauri живёт на своём origin (`http://tauri.localhost` на Windows и
# Android), и если сервер не назвал его в CORS_ORIGINS, движок отбивает каждый
# запрос ЕЩЁ ДО сервера. Снаружи это выглядит как поломка синхронизации: вход
# проходит — токен приезжает диплинком, минуя сеть, — а заметки не появляются
# никогда. В журналах API таких запросов нет вовсе, поэтому искать причину
# приходится с другого конца; проверка ставит её на место.
#
# Смотрим не на код ответа, а на заголовок: 200 без `access-control-allow-origin`
# для приложения означает «нельзя».
verify_app_origin() {
  local origin='http://tauri.localhost' headers
  headers="$(curl -sS -i --max-time 10 -X OPTIONS \
    -H "Origin: ${origin}" \
    -H 'Access-Control-Request-Method: GET' \
    -H 'Access-Control-Request-Headers: authorization,x-device-id' \
    "${PUBLIC_URL}/api/v1/auth/methods" 2>/dev/null || true)"
  case "$(printf '%s' "${headers}" | tr 'A-Z' 'a-z')" in
    *"access-control-allow-origin: ${origin}"*)
      log 'CORS: окно приложения допущено к API.' ;;
    *)
      log "CORS: origin ${origin} НЕ разрешён — приложения не смогут синхронизироваться."
      log 'Лечение: CORS_ORIGINS в deploy/docker-compose.yml обязан содержать адреса окон Tauri.'
      return 1 ;;
  esac
}

# Документы для согласий: `/terms` и `/privacy`.
#
# Кодом 200 тут ничего не докажешь, и это главное. Если в vhost'е нет блока для
# такого адреса, запрос доезжает до SPA-фолбэка и nginx отдаёт index.html —
# двести, знакомый экран, и ни слова соглашения. Именно так и было: блоки жили
# в репозитории, а на сервере стоял конфиг, выложенный до их появления
# (nginx правит только провижн, обычный деплой к нему не подходит), и человек
# на экране входа ставил галочку «принимаю условия» под ссылкой, которая
# открывала приложение.
#
# Поэтому смотрим не на код, а на признак самой страницы: её разметку рисует
# API, и обёртка `<main class="sheet">` есть только у неё.
verify_documents() {
  local page code body
  # Прежние адреса — их знают выложенные сборки — и новые адреса пакета, на
  # которые ссылается приложение с этой версии. Пропустить вторые значило бы
  # проверять то, чем человек уже не пользуется.
  for page in terms privacy legal/terms legal/privacy legal/notes legal/consent/marketing; do
    body="$(curl -sS --max-time 10 "${PUBLIC_URL}/${page}" 2>/dev/null || true)"
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      "${PUBLIC_URL}/${page}" 2>/dev/null || true)"
    case "${code}" in
      2*) ;;
      *)  log "/${page} отвечает ${code} — документ недоступен."; return 1 ;;
    esac
    case "${body}" in
      *'<main class="sheet">'*)
        log "/${page} открывается документом." ;;
      *)
        log "/${page} отвечает ${code}, но отдаёт НЕ документ — похоже, запрос ушёл в SPA."
        log 'Причина обычно одна: на сервере старый vhost без блока для этого адреса.'
        log 'Лечение: прогнать workflow «Провижн zapiski.cmpas.ru (nginx + TLS)».'
        return 1 ;;
    esac
  done

  # Опубликованная заметка. Ключа для пробы у нас нет и быть не должно, зато
  # есть надёжный признак: на НЕсуществующий ключ API отвечает 404, а SPA-
  # фолбэк — двумястами с index.html. То есть 200 здесь означает ровно одно:
  # запрос до API не дошёл, и человек, открывший чужую ссылку, увидит вместо
  # заметки пустое приложение.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    "${PUBLIC_URL}/p/probe-zapiski-deploy" 2>/dev/null || true)"
  case "${code}" in
    404) log 'Публикация проведена в API (несуществующий ключ честно даёт 404).' ;;
    2*)  log "/p/ отвечает ${code} на несуществующий ключ — запрос уходит в SPA, а не в API."
         log 'Лечение: прогнать workflow «Провижн zapiski.cmpas.ru (nginx + TLS)».'
         return 1 ;;
    *)   log "/p/ отвечает ${code} — публикация недоступна."; return 1 ;;
  esac
}

main() {
  guard_not_cmpas
  check_prereqs
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
  # --if-present: если в server/package.json вдруг не окажется скрипта migrate,
  # шаг просто ничего не делает. Настоящая ошибка миграции роняет деплой
  # как положено.
  if ! run_migrations; then
    dump_diagnostics
    fail 'Миграции БД не прошли.'
  fi

  if ! wait_for_api_health; then
    dump_diagnostics
    fail 'API ЗАПИСОК не стал здоровым. Стек оставлен как есть для разбора; КОМПАС.Дневник не затронут.'
  fi

  if ! verify_public; then
    dump_diagnostics
    fail "Стек поднялся, но снаружи ${PUBLIC_URL} не обслуживается. Смотрите vhost и docroot; сам API при этом здоров."
  fi

  # Вход по почте — единственный путь в аккаунт без Яндекса, и держится он на
  # чужом postfix'е по адресу docker0. Если релей не отвечает, письма не
  # уходят: приложение честно говорит «письмо ушло», а его нет. Отсюда
  # «авторизация через email в принципе ничего не делает».
  #
  # Деплой из-за этого не валим — почта не мешает работе с заметками, — но
  # молчать нельзя: без этой строки недоступный релей обнаруживает только
  # пользователь.
  check_mail_relay

  log 'Готово. Состояние стека:'
  dc ps 2>&1 || true

  # Только чтение: фиксируем в логе, что Дневник как работал, так и работает.
  # Никаких действий над ним не выполняется — даже если он лежит, это не наш
  # деплой его уронил и не нам его чинить отсюда.
  log "Контроль изоляции — контейнер Дневника cmpas-app: $(container_state cmpas-app) (мы его не трогали)"
}

main "$@"
