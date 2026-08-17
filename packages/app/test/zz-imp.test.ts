import { describe, expect, it } from 'vitest';
import * as ui from '@zapiski/ui';
describe('импорты', () => {
  it('что undefined', () => {
    for (const name of ['BottomSheet', 'Button', 'IconButton', 'IconFolder', 'IconMic', 'IconPaperclip']) {
      console.log(name, typeof (ui as Record<string, unknown>)[name]);
    }
    expect(true).toBe(true);
  });
});
