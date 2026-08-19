/**
 * Что уезжает вместе с заметкой, кроме текста.
 *
 * На снимке заказчика в заметке есть фотография, а в Telegram уехала строка
 * `![|258](Images/2026-08-15_4d619f.png)` — то есть картинка потерялась
 * целиком. Здесь проверяется список файлов, который прикладывается к тексту.
 *
 * Главное в этих проверках — не «нашли картинку», а ЧЕГО В СПИСКЕ НЕТ:
 * чужого адреса, файла не той природы и второй копии одного и того же.
 */
import { describe, expect, it } from 'vitest';

import { noteImagePaths, SHARE_IMAGE_LIMIT } from '../src/markdown/attachments.js';

describe('картинки заметки для отправки', () => {
  it('берёт вставленные картинки в порядке заметки', () => {
    const note = `# Пост

![|258](Images/2026-08-15_4d619f.png)

текст

![подпись](Images/второе.jpg)
`;
    expect(noteImagePaths(note)).toEqual([
      'Images/2026-08-15_4d619f.png',
      'Images/второе.jpg',
    ]);
  });

  it('одна и та же картинка уезжает один раз', () => {
    const note = '![](Images/a.png)\n\n![снова она](Images/a.png)\n';
    expect(noteImagePaths(note)).toEqual(['Images/a.png']);
  });

  it('чужие адреса не наши файлы: их не читать и не отправлять', () => {
    const note = `![](https://example.com/a.png)

![](//example.com/b.png)

![](data:image/png;base64,iVBORw0KGgo=)
`;
    expect(noteImagePaths(note)).toEqual([]);
  });

  it('ссылка на заметку картинкой не становится', () => {
    /* Без `!` это ссылка, а не вставка: отправлять по ней нечего. */
    expect(noteImagePaths('[Images/a.png](Images/a.png)')).toEqual([]);
  });

  it('вложение не той природы остаётся в тексте, а не уезжает файлом', () => {
    const note = '![](Other%20files/договор.pdf)\n\n![](Audio/запись.m4a)\n';
    expect(noteImagePaths(note)).toEqual([]);
  });

  it('якорь и параметры к файлу на диске отношения не имеют', () => {
    expect(noteImagePaths('![](Images/a.png?v=2)')).toEqual(['Images/a.png']);
  });

  it('счёт ограничен: заметка на сто картинок не превращается в сто файлов', () => {
    const note = Array.from({ length: 30 }, (_, i) => `![](Images/${i}.png)`).join('\n\n');
    expect(noteImagePaths(note)).toHaveLength(SHARE_IMAGE_LIMIT);
    expect(noteImagePaths(note, 3)).toEqual(['Images/0.png', 'Images/1.png', 'Images/2.png']);
  });

  it('картинка внутри кода — это пример разметки, а не вложение', () => {
    expect(noteImagePaths('```\n![](Images/a.png)\n```\n')).toEqual([]);
  });
});
