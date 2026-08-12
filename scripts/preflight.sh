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
# Сгенерированный CSS обязан совпадать с design/tokens.json: правка в CSS
# выглядит работающей и живёт ровно до следующей генерации.
step 'Токены собраны из источника' node packages/ui/scripts/build-tokens.mjs --check
step 'Тесты' pnpm -r test
step 'Сборка PWA' pnpm --filter '@zapiski/web...' build
# Значения токенов на экране должны совпадать с `design/tokens.json` —
# единственным артефактом передачи «дизайн → код». Сравниваются ВЫЧИСЛЕННЫЕ
# значения в браузере: между файлом и экраном стоят каскад и порядок импортов,
# и расходится именно там.
step 'Токены против источника дизайна' node scripts/check-design-tokens.mjs
# Сквозной прогон в настоящем браузере. Он здесь потому, что модульные тесты
# идут в happy-dom, где нет ни раскладки, ни обрезания по overflow, ни вьюпорта,
# ни тача, — и целый класс отказов проходит мимо них незамеченным. Так и вышло:
# меню панели исправно появлялось в дереве и не появлялось на экране.
# `--strict` обязателен: без него прогон «пропускается» с кодом 0 при любой
# нехватке, то есть выдаёт зелёный свет, ничего не проверив.
step 'Живой браузер: сквозной прогон' node scripts/walkthrough.mjs --strict
# Одно кольцо фокуса на поле (REBUILD §1.5). Правила лежат в разных пакетах и
# складываются только на экране — поэтому меряются вычисленные стили.
step 'Одно кольцо фокуса' node scripts/check-focus-ring.mjs
# Растровые иконки собираются из одного SVG. Расхождение молчаливо: в сторах
# и на панели задач оказывается знак, которого нет в исходнике.
step 'Иконки против источника' node scripts/gen-icons.mjs --check
# Размеры отрисованных элементов против эталона (REBUILD §3). Токен может быть
# верным, а к элементу приложен не тот — так кнопка и брала радиус 16 вместо 14.
step 'Размеры против эталона' node scripts/check-measurements.mjs
# Политика безопасности оболочек не должна убивать стили редактора. Дешёвая
# статическая проверка, за которой стоит дорогой дефект: один инлайновый
# <style> в HTML заставлял Tauri добавить nonce в `style-src`, а nonce отменяет
# 'unsafe-inline' — и на устройстве умирало ВСЁ оформление CodeMirror и панели.
# Браузером это не ловится: связка «HTML + Tauri» существует только на
# устройстве, а веб-сборка той же политики не получает.
step 'CSP оболочек против стилей редактора' node scripts/check-csp.mjs
step 'Импорты Kotlin' pnpm --filter @zapiski/mobile android:kotlin:check
step 'Самопроверка оверлея Android' pnpm --filter @zapiski/mobile android:overlay:selftest
# Отладочный ключ подписи должен раскодироваться и содержать нужный алиас: без
# него debug-сборки снова получат случайную подпись, и каждая следующая
# перестанет ставиться поверх предыдущей («Приложение не установлено»).
step 'Отладочный ключ Android' bash -c '
  set -euo pipefail
  tmp="$(mktemp)"
  base64 -d apps/mobile/keys/debug.keystore.base64 > "$tmp"
  keytool -list -keystore "$tmp" -storepass android -alias androiddebugkey >/dev/null
  rm -f "$tmp"'
step 'Скрипты, исполняемые на сервере' bash -c 'bash -n deploy/deploy-production-remote.sh && bash -n deploy/merge-update-manifest.sh'

# Битый workflow не даёт ни одного job'а: прогон падает за секунду, и в списке
# вместо названия стоит путь к файлу. Понять по такому прогону, что случилось,
# нельзя — логов нет. Поэтому разбираем файлы здесь.
workflows_check() {
  python3 - <<'PY'
import glob, re, sys, yaml

problems = []
for path in sorted(glob.glob('.github/workflows/*.yml')):
    text = open(path, encoding='utf-8').read()
    try:
        yaml.safe_load(text)
    except Exception as error:
        problems.append(f'{path}: не разбирается как YAML — {error}')
        continue

    # `secrets` в условии шага GitHub не принимает: контекст там недоступен, и
    # файл отвергается целиком. Значение кладут в env у job'а и проверяют его.
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if re.match(r'^-?\s*if\s*:', stripped) and 'secrets.' in stripped:
            problems.append(
                f'{path}:{number}: `secrets` в условии — недопустимо. '
                'Положите значение в env у job\'а и проверяйте env.'
            )

for problem in problems:
    print(problem, file=sys.stderr)
sys.exit(1 if problems else 0)
PY
}
step 'Файлы workflow' workflows_check

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
