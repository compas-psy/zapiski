import { describe, expect, it } from 'vitest';
import { makeState, makeView, decorationsOf } from './helpers.js';

describe('базовая работоспособность', () => {
  it('состояние создаётся и дерево разбирается', () => {
    const state = makeState('# Заголовок\n\nТекст **жирный**.');
    expect(state.doc.lines).toBe(3);
    expect(decorationsOf(state).length).toBeGreaterThan(0);
  });

  it('представление монтируется в DOM', () => {
    const view = makeView('# Заголовок\n\nТекст.');
    expect(view.dom.isConnected).toBe(true);
    expect(view.state.doc.toString()).toContain('Заголовок');
    view.destroy();
  });
});
