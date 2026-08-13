/**
 * Мини-плеер аудио (ITERATION-1 §5, COMPONENTS §8).
 *
 * Заказчик про прежний вид: «пустой аудио-плеер — есть воспроизведение, но
 * нужна длительность и название трека». Здесь закреплено ровно это: что
 * плеер называет трек и что длительность он добывает даже тогда, когда её не
 * отдали с метаданными.
 *
 * Про честность этих проверок. jsdom не проигрывает звук: `duration`,
 * `readyState` и события здесь подставлены руками. Значит, проверяется
 * ЛОГИКА виджета, а не работа медиа-движка. Настоящий Chromium прогонялся
 * отдельно, вживую (см. сообщение коммита); тесты нужны, чтобы эта логика не
 * рассыпалась незаметно потом.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioWidget } from '../src/live-preview/widgets.js';

/** Подменяет медиа-свойства, которых в jsdom нет. */
function fakeMedia(dom: HTMLElement, duration: number): HTMLAudioElement {
  const audio = dom.querySelector('audio') as HTMLAudioElement;
  let current = 0;
  let length = duration;
  Object.defineProperty(audio, 'duration', { configurable: true, get: () => length });
  Object.defineProperty(audio, 'currentTime', {
    configurable: true,
    get: () => current,
    set(value: number) {
      /* Перемотка за конец — тот самый приём, которым добывается длина
         потокового контейнера. Настоящий браузер в ответ досчитывает
         длительность и присылает `durationchange`. */
      if (value > 1e9) {
        length = 7;
        audio.dispatchEvent(new Event('durationchange'));
        return;
      }
      current = value;
    },
  });
  Object.defineProperty(audio, 'readyState', { configurable: true, get: () => 1 });
  audio.play = vi.fn(async () => {
    audio.dispatchEvent(new Event('play'));
  });
  audio.pause = vi.fn(() => {
    audio.dispatchEvent(new Event('pause'));
  });
  return audio;
}

const text = (dom: HTMLElement, cls: string): string =>
  dom.querySelector(`.cm-z-audio__${cls}`)?.textContent ?? '';

let dom: HTMLElement;
beforeEach(() => {
  dom = new AudioWidget('blob:звук', 'Разговор с бухгалтером.m4a').toDOM();
});

describe('мини-плеер называет трек', () => {
  it('имя видно в тексте карточки, а не только экранному диктору', () => {
    /* Раньше имя жило единственно в `aria-label` кнопки: глазами плеер был
       безымянным, за что и получил «пустой». */
    expect(text(dom, 'name')).toBe('Разговор с бухгалтером.m4a');
  });

  it('полное имя остаётся в подсказке, даже если строка обрезана', () => {
    expect(dom.querySelector('.cm-z-audio__name')?.getAttribute('title')).toBe(
      'Разговор с бухгалтером.m4a',
    );
  });
});

describe('мини-плеер показывает длительность', () => {
  it('после метаданных — «прошло / всего»', () => {
    const audio = fakeMedia(dom, 7);
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(text(dom, 'time')).toBe('0:00 / 0:07');
  });

  it('минуты и секунды разделяются двоеточием с ведущим нулём', () => {
    const audio = fakeMedia(dom, 754);
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.currentTime = 65;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(text(dom, 'time')).toBe('1:05 / 12:34');
  });

  it('контейнер без длительности: она добывается перемоткой за конец', () => {
    /* Голосовое из мессенджера (ogg/opus) и запись `MediaRecorder` приходят
       с `Infinity`. Прежний плеер печатал на это `--:--` навсегда. */
    const audio = fakeMedia(dom, Number.POSITIVE_INFINITY);
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(text(dom, 'time')).toBe('0:00 / 0:07');
    /* И перемотка не оставила плеер в конце записи. */
    expect(audio.currentTime).toBe(0);
  });

  it('пока длительность неизвестна — «0:00», а не прочерки', () => {
    expect(text(dom, 'time')).toBe('0:00');
  });
});

describe('мини-плеер играет и останавливается', () => {
  it('нажатие запускает, повторное — останавливает', () => {
    const audio = fakeMedia(dom, 7);
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => true });
    const play = dom.querySelector('.cm-z-audio__play') as HTMLButtonElement;
    play.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(audio.play).toHaveBeenCalled();

    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    play.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(audio.pause).toHaveBeenCalled();
  });

  it('уничтожение виджета останавливает звук', () => {
    /* Виджет строится только для видимых строк: прокрутка уничтожает его
       DOM, а откреплённый `<audio>` продолжает играть — и выключить его
       нечем, кнопки на экране больше нет. */
    const audio = fakeMedia(dom, 7);
    new AudioWidget('blob:звук', 'x').destroy(dom);
    expect(audio.pause).toHaveBeenCalled();
  });

  it('скорость переключается по кругу и подписана текстом', () => {
    const audio = fakeMedia(dom, 7);
    const rate = dom.querySelector('.cm-z-audio__rate') as HTMLButtonElement;
    expect(rate.textContent).toBe('1×');
    rate.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(audio.playbackRate).toBe(1.25);
    expect(rate.textContent).toBe('1,25×');
  });
});
