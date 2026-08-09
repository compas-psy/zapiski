/**
 * Заглушки измерений для jsdom.
 *
 * CodeMirror измеряет реальную геометрию текста; jsdom не реализует
 * `Range.getClientRects`, из-за чего в логи льётся шум. Логика редактора от
 * этих измерений не зависит: всё, что мы проверяем, — состояние и декорации.
 */

const emptyRect = (): DOMRect =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect;

const emptyRectList = (): DOMRectList => {
  const list: DOMRect[] = [];
  return Object.assign(list, {
    item: (index: number) => list[index] ?? null,
  }) as unknown as DOMRectList;
};

if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = emptyRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = emptyRect;
  }
}

if (typeof Element !== 'undefined' && typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = emptyRectList;
}
