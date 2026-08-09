#!/usr/bin/env bash
# Прогнать у себя ровно то, что гоняет job «Проверки и сборка PWA» деплоя.
#
# Зачем отдельный скрипт, а не «просто запусти тесты». Проверки CI идут на
# ЧИСТОМ дереве по последнему коммиту, а у разработчика в рабочем дереве лежат
# незакоммиченные правки — свои и чужие. Поэтому скрипт делает временный
# git worktree на HEAD и проверяет именно то, что уедет на сервер.
#
#   bash scripts/preflight.sh          # проверить HEAD
#   bash scripts/preflight.sh --dirty  # проверить рабочее дерево как есть
#
# Шаги и их порядок повторяют .github/workflows/deploy-zapiski.yml. Если там
# что-то добавили — добавьте и здесь, иначе смысл скрипта теряется.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIRTY=0
[[ "${1:-}" == "--dirty" ]] && DIRTY=1

if [[ $DIRTY -eq 1 ]]; then
  WORK="$ROOT"
  echo "Проверяю рабочее дерево (--dirty)."
else
  WORK="$(mktemp -d -t zapiski-preflight-XXXXXX)"
  # Уборка обязана случиться при любом исходе: иначе git-worktree засоряется
  # ссылками на удалённые каталоги и следующий запуск падает на ровном месте.
  cleanup() { git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || rm -rf "$WORK"; }
  trap cleanup EXIT
  git -C "$ROOT" worktree add --detach "$WORK" HEAD >/dev/null
  echo "Проверяю HEAD ($(git -C "$ROOT" rev-parse --short HEAD)) в отдельном дереве."
fi

cd "$WORK"

FAILED=()
step() {
  local title="$1"; shift
  printf '══ %s\n' "$title"
  if "$@" >/tmp/preflight-step.log 2>&1; then
    printf '   ✓\n'
  else
    printf '   ✗ ПАДЕНИЕ\n'
    tail -30 /tmp/preflight-step.log | sed 's/^/   │ /'
    FAILED+=("$title")
  fi
}

step 'Установка зависимостей' pnpm install --frozen-lockfile --prefer-offline
step 'Проверка типов' pnpm -r typecheck
step 'Линт токенов' pnpm run lint:tokens
step 'Тесты' pnpm -r test
step 'Сборка PWA' pnpm --filter '@zapiski/web...' build
step 'Самопроверка оверлея Android' pnpm --filter @zapiski/mobile android:overlay:selftest
step 'Скрипты, исполняемые на сервере' bash -c 'bash -n deploy/deploy-production-remote.sh && bash -n deploy/merge-update-manifest.sh'

compose_check() {
  # Значение живёт только внутри проверки: compose обязан видеть переменную,
  # иначе `${VAR:?}` прервёт разбор ещё до синтаксической проверки.
  export ZAPISKI_DB_PASSWORD="проверка-$RANDOM"
  touch deploy/.env
  local code=0
  docker compose --file deploy/docker-compose.yml config --quiet || code=$?
  rm -f deploy/.env
  return $code
}
if command -v docker >/dev/null 2>&1; then
  step 'deploy/docker-compose.yml' compose_check
else
  echo '══ deploy/docker-compose.yml'
  echo '   · пропущено: нет docker. В CI шаг выполняется.'
fi

# `nginx -t` требует запущенного демона docker, а не только клиента, поэтому
# локально он чаще всего недоступен. Молчать об этом нельзя: пропущенная
# проверка — не пройденная проверка.
if docker info >/dev/null 2>&1; then
  step 'Синтаксис vhost' docker run --rm \
    -v "${PWD}/deploy/zapiski.cmpas.ru.nginx.conf:/etc/nginx/conf.d/zapiski.conf:ro" \
    nginx:stable-alpine nginx -t
else
  echo '══ Синтаксис vhost'
  echo '   · пропущено: демон docker не запущен. В CI шаг выполняется.'
fi

echo
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo 'Преflight пройден: можно пушить.'
else
  echo "Преflight провален (${#FAILED[@]}): ${FAILED[*]}"
  exit 1
fi
