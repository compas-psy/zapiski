/**
 * «Переносить выполненные вниз» (ITERATION-1 §3).
 *
 * Настройка была объявлена в интерфейсе и не существовала в коде: тумблер
 * держал состояние в `useState` и не делал ничего. §3 говорит прямо —
 * неработающий переключатель хуже отсутствующего, — поэтому он либо работает,
 * либо его нет.
 *
 * По умолчанию настройка ВЫКЛЮЧЕНА, и это не осторожность: человек отмечает
 * пункт и глазами держит соседние, а прыжок строки сбивает чтение
 * (BEHAVIOR §2.3).
 */
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { moveDoneToBottom, reorderTasks, taskOrder } from '../src/input/task-order.js';

function state(text: string, enabled: boolean): EditorState {
  return EditorState.create({ doc: text, extensions: [taskOrder(enabled)] });
}

/** Применяет перестановку и возвращает получившийся текст. */
function reordered(text: string, line: number, enabled = true): string {
  const before = state(text, enabled);
  const change = reorderTasks(before, line);
  if (!change) return text;
  return before.update({ changes: change }).state.doc.toString();
}

const LIST = '- [ ] купить билеты\n- [x] забрать посылку\n- [ ] позвонить\n';

describe('порядок задач', () => {
  it('выключено по умолчанию — строка остаётся на месте', () => {
    expect(reordered(LIST, 2, false)).toBe(LIST);
    expect(state(LIST, false).facet(moveDoneToBottom)).toBe(false);
  });

  it('включено — выполненные уезжают вниз', () => {
    expect(reordered(LIST, 2)).toBe('- [ ] купить билеты\n- [ ] позвонить\n- [x] забрать посылку\n');
  });

  it('порядок внутри групп сохраняется', () => {
    const list = '- [x] раз\n- [ ] два\n- [x] три\n- [ ] четыре\n';
    expect(reordered(list, 1)).toBe('- [ ] два\n- [ ] четыре\n- [x] раз\n- [x] три\n');
  });

  it('уже упорядоченный список не трогается вовсе', () => {
    /* Возврат `null` важнее косметики: иначе каждая отметка клала бы в историю
       отмены пустой шаг, и Ctrl+Z переставал бы что-либо откатывать. */
    const list = '- [ ] раз\n- [x] два\n';
    expect(reorderTasks(state(list, true), 1)).toBeNull();
  });

  it('соседний список через абзац не затрагивается', () => {
    /* Границей служит любая не-задача: иначе отмеченный пункт улетел бы в
       чужой список через весь документ. */
    const text = '- [x] раз\n- [ ] два\n\nтекст между\n\n- [ ] три\n- [ ] четыре\n';
    expect(reordered(text, 1)).toBe('- [ ] два\n- [x] раз\n\nтекст между\n\n- [ ] три\n- [ ] четыре\n');
  });

  it('вложенный уровень — свой блок', () => {
    const text = '- [ ] верх\n  - [x] вложенный\n  - [ ] второй вложенный\n';
    expect(reordered(text, 2)).toBe('- [ ] верх\n  - [ ] второй вложенный\n  - [x] вложенный\n');
  });

  it('нумерованные задачи считаются так же', () => {
    expect(reordered('1. [x] раз\n2. [ ] два\n', 1)).toBe('2. [ ] два\n1. [x] раз\n');
  });

  it('строка вне списка ничего не переставляет', () => {
    expect(reorderTasks(state('обычный текст\n', true), 1)).toBeNull();
  });

  it('одинокая задача не переставляется', () => {
    expect(reorderTasks(state('- [x] одна\n', true), 1)).toBeNull();
  });
});
