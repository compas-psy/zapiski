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

# Локаль для браузерных прогонов. В окружении с `POSIX` хранилище браузера
# (OPFS) не заводит файл с кириллическим именем — падает на `Идеи.md`, то есть
# на обычном имени заметки, — и прогон жалуется на продукт вместо окружения.
export LC_ALL="${LC_ALL:-C.UTF-8}"
export LANG="${LANG:-C.UTF-8}"

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
# Промостраница обещает сборки по постоянным адресам, а кладут их туда
# workflow'ы: имя живёт в HTML и в YAML сразу, и ничто их не связывало.
# Переименование в workflow превращало кнопку «Скачать» в 404 молча.
step 'Ссылки промостраницы против выкладки' node scripts/check-promo-links.mjs
# Сквозной прогон в настоящем браузере. Он здесь потому, что модульные тесты
# идут в happy-dom, где нет ни раскладки, ни обрезания по overflow, ни вьюпорта,
# ни тача, — и целый класс отказов проходит мимо них незамеченным. Так и вышло:
# меню панели исправно появлялось в дереве и не появлялось на экране.
# `--strict` обязателен: без него прогон «пропускается» с кодом 0 при любой
# нехватке, то есть выдаёт зелёный свет, ничего не проверив.
step 'Живой браузер: сквозной прогон' node scripts/walkthrough.mjs --strict
step 'Живой браузер: горячие клавиши' node scripts/check-hotkeys.mjs --strict
# Ширина экранов на телефонных вьюпортах. Заведён по отказу, который прошёл
# мимо всех тестов сразу: экран редактора занимал 464 px при устройстве 360 —
# за кромкой оставались «назад», кнопка сведений и половина статус-строки, а
# в настройках шесть разделов из восьми прятались за горизонтальной лентой.
# Меряются 320, 360, 412 и планшет — «универсальное решение» проверяется на
# разных ширинах, а не на одной.
step 'Живой браузер: ширина экранов' node scripts/check-viewport-fit.mjs --strict
# Логотип на кнопке входа обязан загрузиться, а не просто иметь адрес: в
# happy-dom картинки не грузятся, и битая ссылка проходит мимо тестов.
step 'Живой браузер: экран входа' node scripts/check-signin-screen.mjs --strict
# Шифрование от установки пароля до снятия. Модульные тесты проверяют
# контроллер, а ломались ПУТИ к нему: «⋯» в шапке заметки не открывал ничего
# на десктопе, подтверждение снятия не вызывало действия, а открытый текст
# уходил поверх контейнера, стоило выйти из заметки и вернуться.
step 'Живой браузер: шифрование' node scripts/check-encryption.mjs --strict
# Форма обратной связи: дорога к ней идёт нажатиями («Настройки → О приложении»),
# и модульные тесты её не проходят — они зовут метод. Плюс блок «Что будет
# отправлено» несёт главное обещание формы, а «есть в дереве» и «видно на
# экране» в happy-dom неразличимы.
step 'Живой браузер: обратная связь' node scripts/check-feedback-form.mjs --strict
# Картинки в заметке стоят рядом, пока помещаются по ширине. Модульные тесты
# видят документ, а «в ряд» от «столбиком» отличает только раскладка: в
# happy-dom нет ни ширин, ни переносов.
step 'Живой браузер: ряд картинок' node scripts/check-image-row.mjs --strict
# Таблица из чужого `.md`: колонки обязаны стоять ровно, а длинный текст —
# переноситься внутри ячейки. Разметка разбиралась верно и до починки — на
# экране расползалась раскладка, а её happy-dom не считает вовсе.
step 'Живой браузер: показ таблицы' node scripts/check-table-render.mjs --strict
# Перетаскивание в библиотеке: «должно подсвечиваться, куда сейчас перетягиваю».
# Подсветка складывается из атрибута в дереве и правила в чужом пакете, а
# сходятся они только на экране — в happy-dom вычисленных стилей нет.
step 'Живой браузер: перетаскивание' node scripts/check-drag-drop.mjs --strict
# Расход памяти на настоящем хранилище. Заведён по отказу «открытый сайт в
# Chrome занимает 804 МБ»: индекс держал текст деревом строковых склеек, и
# восемьсот заметок стоили 78 МБ кучи вместо 18. Модульным тестом это не
# ловится — расход виден только в куче настоящего движка.
step 'Живой браузер: память' node scripts/check-memory.mjs --strict
# Ширина панелей мышью: курсор над границей, перетаскивание и запоминание.
# Всё три утверждения — про экран: правило курсора живёт в CSS, класс ставит
# компонент, а ширина панели есть только в раскладке.
step 'Живой браузер: ширина панелей' node scripts/check-panes.mjs --strict
# Корзина в узкой колонке: заголовок шапки целиком, метастрока в одну строку,
# «Восстановить» не съедает полстроки. Заказчик: «Корзина выглядит ужасно».
# Всё три утверждения существуют только в раскладке — в happy-dom нет ни
# ширины колонки, ни переноса, ни обрезания.
step 'Живой браузер: корзина' node scripts/check-trash.mjs --strict
# Начертания пальцем: на выделении в панели стоят B · I · U · S, каждая видна
# целиком и срабатывает с одного касания. Модульно это не проверяется: команды
# существовали и раньше — не существовало пути к ним на телефоне.
step 'Живой браузер: начертания' node scripts/check-inline-format.mjs --strict
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
# Своя строка заголовка не должна соседствовать с системной. Плагин состояния
# окна восстанавливает StateFlags::all(), включая DECORATIONS, — и у всех, кто
# обновился с версии с системной рамкой, кнопок окна становится два ряда.
# На чистой установке этого не видно никогда.
step 'Хром окна: одна строка заголовка' node scripts/check-window-chrome.mjs
# Свернуть, закрыть, развернуть и потащить окно — команды ядра Tauri, и каждая
# проходит проверку прав. Набор `core:default` даёт по окну только чтение
# состояния, поэтому без явных прав кнопки молча ничего не делают: промис
# отвергнут, `void` его проглатывает, на экране — ничего. Ровно так окно и
# «не сворачивалось».
step 'Права на управление окном' node scripts/check-window-permissions.mjs
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

# ── Ворота производственной подписи Android ────────────────────────────────
#
# Заказчик: «сертификат подписи в андроид блокируется проверкой при установке и
# не проходит проверку Play Защиты». Дело было не в ключе: сборка работала
# fail-open — нет секретов, берём отладочный ключ, собираем `--debug`, и те же
# строки кладут результат в `/updates/latest/zapiski.apk`, откуда его качает
# человек по кнопке.
#
# Правило восстановлению не подлежит: публичный файл трогает только
# производственная сборка с ПРОВЕРЕННОЙ подписью. Ниже — три утверждения о
# самом файле workflow, потому что логика правил живёт в
# `apps/mobile/scripts/android-release-gate.mjs` (её испытывают тесты), а вот
# проводка этих правил существует только здесь.
android = '.github/workflows/build-android.yml'
try:
    spec = yaml.safe_load(open(android, encoding='utf-8'))
except Exception as error:  # разобрать не удалось — об этом уже сказано выше
    spec = None

if spec:
    steps = spec['jobs']['build']['steps']
    ship = next((s for s in steps if 'сервер' in str(s.get('name', ''))), None)
    if ship is None:
        problems.append(f'{android}: шага доставки на сервер нет — проверять нечего')
    else:
        script = ship.get('run', '')
        # Режем по НАЗНАЧЕНИЮ каталога, а не по первому упоминанию строки:
        # ворота объясняются комментарием, и комментарий тоже содержит адрес.
        head = script.split('latest="/var/www')[0]
        if 'PROMOTED' not in head or 'VERIFIED' not in head:
            problems.append(
                f'{android}: путь к /updates/latest/ не закрыт воротами PROMOTED+VERIFIED — '
                'публичную ссылку снова может переписать отладочная сборка'
            )

    build_step = next((s for s in steps if s.get('name') == 'tauri android build'), None)
    if build_step and '--debug' in build_step.get('run', ''):
        if 'build_type' not in build_step.get('run', ''):
            problems.append(
                f'{android}: выбор `--debug` не опирается на build_type — '
                'производственная сборка снова сможет оказаться отладочной'
            )

    release_if = str(spec['jobs']['release'].get('if', ''))
    if 'verified_release' not in release_if:
        problems.append(
            f'{android}: job `release` не требует verified_release — '
            'в GitHub Release может уехать непроверенный APK'
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
