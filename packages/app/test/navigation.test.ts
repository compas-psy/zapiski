/**
 * История навигации: онбординг — дверь в одну сторону.
 *
 * Найдено живым прогоном шифрования, а не тестом: после того как заметка
 * зашифрована, два нажатия «Назад» приводили на первый экран онбординга —
 * с предложением выбрать хранилище поверх уже готового хранилища.
 *
 * Причина была в `navigate()`: он клал ТЕКУЩИЙ маршрут в стек безусловно, и
 * онбординг попадал в историю наравне с обычными экранами.
 */
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

async function boot(onboarded: boolean): Promise<AppController> {
  const host = createTestHost({ files: { 'Заметка.md': '# Заметка\n' }, prefs: { onboarded } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

describe('онбординг не возвращается кнопкой «назад»', () => {
  it('уход с онбординга не кладёт его в историю', async () => {
    const app = await boot(false);
    expect(app.getState().route.name).toBe('onboarding');

    app.navigate({ name: 'list' });
    app.back();

    // Назад с первого же экрана после онбординга — список, а не онбординг.
    expect(app.getState().route.name).not.toBe('onboarding');
  });

  it('сколько бы шагов ни прошли, назад не доводит до онбординга', async () => {
    const app = await boot(false);
    app.navigate({ name: 'list' });
    app.navigate({ name: 'note', id: 'Заметка.md' });
    app.navigate({ name: 'settings', section: 'appearance' });

    for (let step = 0; step < 6; step += 1) {
      app.back();
      expect(app.getState().route.name).not.toBe('onboarding');
    }
  });

  it('обычные экраны в историю кладутся по-прежнему', async () => {
    const app = await boot(true);
    app.navigate({ name: 'list' });
    app.navigate({ name: 'settings', section: 'sync' });

    app.back();

    expect(app.getState().route.name).toBe('list');
  });
});
