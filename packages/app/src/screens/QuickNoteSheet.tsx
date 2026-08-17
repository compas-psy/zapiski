/**
 * Быстрая записка: лист над клавиатурой.
 *
 * ── Зачем он и почему не редактор ───────────────────────────────────────────
 *
 * Плитку в шторке и виджет на рабочем столе жмут на ходу: между сессиями, в
 * машине, у лифта. Полный редактор в этот момент требует дождаться списка,
 * выбрать место и потом найти, куда возвращался. Лист спрашивает ровно одно —
 * текст, — и закрывается.
 *
 * До этой правки оба намерения доезжали до оболочки и упирались в пустоту:
 * в `apps/mobile/src/main.tsx` стоял обработчик с комментарием «намеренно
 * пусто», потому что порта в контракте не хватало. То есть плитка и виджет
 * выглядели рабочими и не делали ничего.
 *
 * ── Что на нём есть ─────────────────────────────────────────────────────────
 *
 * Поле текста, выбор папки, скрепка и отправка. Ничего больше: каждая лишняя
 * кнопка здесь — это секунда, за которую мысль успевает уйти.
 *
 * Кнопка голоса **предусмотрена и не показывается** — прямое указание
 * заказчика. Голос → Markdown это P1 (`docs/spec/VOICE.md`), и до тех пор
 * кнопка, которая ничего не делает, хуже отсутствующей: продукт обещает
 * возможность, которой нет. Правило проекта то же самое: `null` у
 * возможности означает «скрыть», а не «показать выключенным» (BEHAVIOR §5.1).
 * Когда порт появится, здесь останется убрать одно условие.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BottomSheet, Button, IconButton, IconFolder, IconMic, IconPaperclip } from '@zapiski/ui';

import { useApp, useAppState, useStrings } from '../state/context.js';

/** Порт голосового ввода. Появится — кнопка покажется сама. */
const VOICE_INPUT_READY = false;

export function QuickNoteSheet(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const copy = strings.quickNote;

  const [text, setText] = useState('');
  const [folder, setFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);

  /* Фокус в поле сразу: лист открыт затем, чтобы писать, а не чтобы смотреть
     на него. Клавиатура на телефоне поднимается тем же действием. */
  useEffect(() => {
    if (state.quickNoteOpen) {
      setText('');
      setSaving(false);
      area.current?.focus();
    }
  }, [state.quickNoteOpen]);

  const empty = text.trim().length === 0;

  async function save(): Promise<void> {
    if (empty || saving) return;
    setSaving(true);
    const path = await app.saveQuickNote(text, folder === '' ? undefined : folder);
    setSaving(false);
    if (path === null) return;
    /* «Открыть» — действием в тосте, а не переходом: человек нажимал плитку,
       чтобы записать и идти дальше, и решать за него, что он хочет читать
       написанное, мы не будем. */
    app.toast({
      message: copy.saved,
      actionLabel: copy.open2,
      onAction: () => app.openNote(path),
    });
    setText('');
  }

  /* Папки хранилища плюс корень. Дерево здесь не нужно: выбор из списка
     быстрее, а вложенность видна по пути. */
  const folders = state.folders.map((node) => node.path);

  return (
    <BottomSheet
      open={state.quickNoteOpen}
      onClose={() => app.closeQuickNote()}
      label={copy.title}
    >
      <div className="za-quick">
        <textarea
          ref={area}
          className="za-quick__text"
          value={text}
          rows={3}
          placeholder={copy.placeholder}
          aria-label={copy.fieldLabel}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            /* Ctrl/Cmd+Enter сохраняет — так же, как отправка в мессенджерах.
               Обычный Enter оставлен переводом строки: записка бывает в две
               строки, и терять вторую из-за привычки нельзя. */
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void save();
            }
          }}
        />

        <div className="za-quick__row">
          {/*
            Выбор папки. Обычный `<select>`, а не своё меню: на Android он
            открывается системным списком, который человек уже знает, и не
            требует места на листе.
          */}
          <label className="za-quick__folder">
            <IconFolder size={16} />
            <span className="z-visually-hidden">{copy.folderLabel}</span>
            <select
              className="za-quick__select"
              value={folder}
              aria-label={copy.folderLabel}
              onChange={(event) => setFolder(event.target.value)}
            >
              <option value="">{copy.rootFolder}</option>
              {folders.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>

          <IconButton
            icon={<IconPaperclip size={18} />}
            label={copy.attach}
            tone="ghost"
            onClick={() => file.current?.click()}
          />
          <input
            ref={file}
            className="z-visually-hidden"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (!picked) return;
              /* Вложение в быстрой записке — это картинка, снятая только что.
                 Разметку собирает контроллер, дописываем её в текст: лист
                 показывает то же, что уедет в файл. */
              void app.attachImage(picked).then((result) => {
                if (result) setText((current) => `${current}${current ? '\n' : ''}${result.markdown}`);
                else app.toast({ message: strings.errors.imageInsertFailed });
              });
            }}
          />

          {/* Голос: порт не готов — кнопки нет вовсе (см. заголовок файла). */}
          {VOICE_INPUT_READY ? (
            <IconButton icon={<IconMic size={18} />} label={copy.voice} tone="ghost" />
          ) : null}

          <span className="za-quick__grow" />

          <Button variant="primary" size="compact" disabled={empty || saving} onClick={() => void save()}>
            {saving ? copy.saving : copy.save}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
