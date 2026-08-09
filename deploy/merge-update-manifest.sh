#!/usr/bin/env bash
#
# Вливает запись ОДНОЙ платформы в общий манифест автообновлений
# /var/www/zapiski.cmpas.ru/updates/latest.json. Исполняется НА СЕРВЕРЕ.
#
# ЗАЧЕМ. Манифест один, а пишут в него две независимые сборки — Windows и
# Android. Пока каждая формировала файл целиком, выигрывала та, что выложилась
# второй: её `platforms` затирал чужую запись, и половина пользователей
# переставала видеть обновление. Совсем разводить их по разным файлам нельзя —
# формат фида (server/src/routes/updates.ts) держит все платформы в одном
# объекте с ОДНОЙ версией наверху.
#
# Поэтому обе сборки больше не знают друг о друге: каждая присылает только свою
# строчку, а слияние, блокировку и атомарную запись берёт на себя этот скрипт.
#
# ФОРМАТ (server/src/routes/updates.ts, manifestSchema):
#   {
#     "version":   "0.3.1",
#     "notes":     "",
#     "pub_date":  "2026-08-09T12:00:00Z",
#     "platforms": { "windows-x86_64": { "signature": "...", "url": "..." } }
#   }
#
# ПРАВИЛА СЛИЯНИЯ (версия в манифесте одна на всех, поэтому без них никак):
#   * версия НОВЕЕ текущей — манифест начинается заново, в нём остаётся только
#     присланная платформа. Оставлять рядом запись от прошлого релиза нельзя:
#     она указывала бы на старый файл под видом новой версии;
#   * версия РАВНА текущей — запись платформы добавляется/заменяется, соседние
#     платформы сохраняются. Ради этого случая всё и затевалось;
#   * версия СТАРШЕ текущей — отказ с кодом 3. Опоздавшая сборка не должна
#     откатывать фид на предыдущий выпуск. Осознанный откат — с --force.
#
# ПРИМЕР ВЫЗОВА из workflow сборки (по ssh):
#   bash /var/www/zapiski/deploy/merge-update-manifest.sh \
#     --platform windows-x86_64 \
#     --version  "${VERSION}" \
#     --url      "https://zapiski.cmpas.ru/updates/${MSI_NAME}" \
#     --signature "${TAURI_SIGNATURE}"
#
# Для Android подпись пустая — APK ставит сам пользователь, Tauri его не
# проверяет; --signature можно не передавать.

set -Eeuo pipefail

MANIFEST="${ZAPISKI_UPDATES_MANIFEST:-/var/www/zapiski.cmpas.ru/updates/latest.json}"
PLATFORM=''
VERSION=''
URL=''
SIGNATURE=''
NOTES=''
FORCE='0'

log()  { printf '[zapiski-manifest] %s\n' "$*"; }
fail() { printf '[zapiski-manifest] ОШИБКА: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Использование:
  merge-update-manifest.sh --platform КЛЮЧ --version ВЕРСИЯ --url АДРЕС
                           [--signature ПОДПИСЬ] [--notes ТЕКСТ]
                           [--manifest ПУТЬ] [--force]

  --platform   ключ платформы в манифесте, например windows-x86_64
               или android-universal
  --version    версия выпуска, например 0.3.1
  --url        абсолютный адрес файла обновления
  --signature  подпись Tauri (для Android не нужна)
  --notes      описание выпуска; пустое не затирает уже записанное
  --manifest   путь к latest.json (по умолчанию в docroot ЗАПИСОК)
  --force      разрешить запись версии СТАРШЕ уже опубликованной
USAGE
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform)  PLATFORM="${2:-}"; shift 2 ;;
    --version)   VERSION="${2:-}";  shift 2 ;;
    --url)       URL="${2:-}";      shift 2 ;;
    --signature) SIGNATURE="${2:-}"; shift 2 ;;
    --notes)     NOTES="${2:-}";    shift 2 ;;
    --manifest)  MANIFEST="${2:-}"; shift 2 ;;
    --force)     FORCE='1';         shift 1 ;;
    -h|--help)   usage ;;
    *) printf 'Неизвестный аргумент: %s\n' "$1" >&2; usage ;;
  esac
done

[ -n "${PLATFORM}" ] || { printf 'Не задан --platform.\n' >&2; usage; }
[ -n "${VERSION}"  ] || { printf 'Не задан --version.\n'  >&2; usage; }
[ -n "${URL}"      ] || { printf 'Не задан --url.\n'      >&2; usage; }

command -v python3 >/dev/null 2>&1 \
  || fail 'на сервере нет python3 (он нужен, чтобы разобрать и собрать JSON).'

MANIFEST_DIR="$(dirname "${MANIFEST}")"
mkdir -p "${MANIFEST_DIR}"

# Блокировка на отдельном файле, а не на самом манифесте: манифест
# перезаписывается через rename, и его inode меняется — блокировка на нём
# разъехалась бы между процессами. Две сборки, финиширующие одновременно,
# на этом месте выстраиваются в очередь.
LOCK="${MANIFEST}.lock"
exec 9>"${LOCK}"
flock -w 60 9 || fail "не удалось получить блокировку ${LOCK} за 60 секунд."

# Значения уезжают в python окружением, а не подстановкой в текст программы:
# подпись Tauri содержит base64 и переводы строк, а notes — произвольный текст
# от человека. Ни то, ни другое не должно попадать в исходник скрипта.
export ZM_MANIFEST="${MANIFEST}" \
       ZM_PLATFORM="${PLATFORM}" \
       ZM_VERSION="${VERSION}" \
       ZM_URL="${URL}" \
       ZM_SIGNATURE="${SIGNATURE}" \
       ZM_NOTES="${NOTES}" \
       ZM_FORCE="${FORCE}"

python3 <<'PYTHON'
import json, os, sys, tempfile
from datetime import datetime, timezone

path      = os.environ['ZM_MANIFEST']
platform  = os.environ['ZM_PLATFORM']
version   = os.environ['ZM_VERSION']
url       = os.environ['ZM_URL']
signature = os.environ.get('ZM_SIGNATURE', '')
notes     = os.environ.get('ZM_NOTES', '')
force     = os.environ.get('ZM_FORCE') == '1'


def split_prerelease(v):
    """Повторяет splitPrerelease из server/src/routes/updates.ts."""
    clean = v[1:] if v[:1] in ('v', 'V') else v
    clean = clean.split('+')[0]
    idx = clean.find('-')
    if idx == -1:
        return clean, None
    return clean[:idx], clean[idx + 1:]


def compare_versions(a, b):
    """Повторяет compareVersions из server/src/routes/updates.ts: -1 / 0 / 1.

    Держать это в согласии с сервером обязательно: если писатель манифеста и
    фид разойдутся в понимании «что новее», клиент получит либо вечное
    предложение обновиться, либо тишину при вышедшем релизе.
    """
    core_a, pre_a = split_prerelease(a)
    core_b, pre_b = split_prerelease(b)

    def parts(core):
        out = []
        for chunk in core.split('.'):
            try:
                out.append(int(chunk))
            except ValueError:
                out.append(0)          # Number.parseInt(...) || 0
        return out

    pa, pb = parts(core_a), parts(core_b)
    for i in range(max(len(pa), len(pb))):
        left = pa[i] if i < len(pa) else 0
        right = pb[i] if i < len(pb) else 0
        if left != right:
            return -1 if left < right else 1

    if pre_a is None and pre_b is None:
        return 0
    if pre_a is None:
        return 1
    if pre_b is None:
        return -1
    return 0 if pre_a == pre_b else (-1 if pre_a < pre_b else 1)


current = None
try:
    with open(path, 'r', encoding='utf-8') as fh:
        loaded = json.load(fh)
    if isinstance(loaded, dict) and isinstance(loaded.get('version'), str) \
       and isinstance(loaded.get('platforms'), dict):
        current = loaded
except FileNotFoundError:
    pass
except (json.JSONDecodeError, OSError) as exc:
    # Битый файл не повод потерять релиз: он не читается ни фидом, ни
    # апдейтером, поэтому переписываем с нуля, но говорим об этом вслух.
    print(f'[zapiski-manifest] предыдущий манифест нечитаем ({exc}), пишем заново',
          file=sys.stderr)

entry = {'signature': signature, 'url': url}

if current is None:
    action = 'создан'
    manifest = {'version': version, 'notes': notes, 'pub_date': '', 'platforms': {}}
else:
    cmp = compare_versions(version, current['version'])
    if cmp > 0:
        action = f"поднят с {current['version']} до {version}"
        manifest = {'version': version, 'notes': notes, 'pub_date': '', 'platforms': {}}
    elif cmp == 0:
        action = 'дополнен'
        manifest = {
            'version': current['version'],
            # Пустые notes от одной из сборок не должны стирать текст,
            # записанный другой.
            'notes': notes or current.get('notes', '') or '',
            'pub_date': '',
            'platforms': dict(current['platforms']),
        }
    else:
        if not force:
            print(
                f'[zapiski-manifest] ОШИБКА: версия {version} старше '
                f"опубликованной {current['version']}. Фид не откатываем. "
                'Если это осознанный откат — повторите с --force.',
                file=sys.stderr,
            )
            sys.exit(3)
        action = f"ОТКАЧЕН с {current['version']} до {version} (--force)"
        manifest = {'version': version, 'notes': notes, 'pub_date': '', 'platforms': {}}

replaced = platform in manifest['platforms']
manifest['platforms'][platform] = entry
manifest['pub_date'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

# Атомарная замена: апдейтер клиента и nginx в любой момент видят либо старый
# файл целиком, либо новый целиком, но никогда не половину.
directory = os.path.dirname(path) or '.'
fd, tmp = tempfile.mkstemp(dir=directory, prefix='.latest.json.')
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp, 0o644)          # раздаёт nginx, читает контейнер API
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise

verb = 'заменена' if replaced else 'добавлена'
print(f'[zapiski-manifest] манифест {action}; запись {platform} {verb}.')
print(f"[zapiski-manifest] версия {manifest['version']}, платформы: "
      f"{', '.join(sorted(manifest['platforms']))}")
PYTHON

log "готово: ${MANIFEST}"
