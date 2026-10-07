import { describe, expect, test, vi } from 'vitest';
import { Dialogs } from '../src/ui/dialogs';

describe('Dialogs', () => {
  test('closeAll closes every registered dialog, a re-registered one once', () => {
    const d = new Dialogs();
    const a = vi.fn();
    const b = vi.fn();
    const b2 = vi.fn();
    d.add('a', a);
    d.add('b', b);
    d.add('b', b2); // replaced, e.g. the map was loaded again
    d.closeAll();
    expect([a.mock.calls.length, b.mock.calls.length, b2.mock.calls.length]).toEqual([1, 0, 1]);
  });

  test('one that throws does not keep the others open', () => {
    const d = new Dialogs();
    const after = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    d.add('broken', () => { throw new Error('gone'); });
    d.add('after', after);
    d.closeAll();
    expect(after).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
