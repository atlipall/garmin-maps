import { afterEach, describe, expect, test, vi } from 'vitest';
import { suggestName, type NameField } from '../src/ui/rename';

/** A text field stand-in: its value and what was last selected. */
class Field extends EventTarget {
  value = '';
  selected: [number, number] | null = null;
  setSelectionRange(start: number | null, end: number | null): void {
    this.selected = [start ?? 0, end ?? 0];
  }
}
const field = () => new Field() as Field & NameField;

afterEach(() => vi.useRealTimers());

describe('suggestName', () => {
  test('a tap on the unchanged suggestion selects all of it', () => {
    const f = field();
    suggestName(f, 'Drive 7 Oct, Selfoss');
    expect(f.value).toBe('Drive 7 Oct, Selfoss');
    f.dispatchEvent(new Event('click'));
    expect(f.selected).toEqual([0, 20]);
  });

  test('focus selects it too, once focus has settled', () => {
    vi.useFakeTimers();
    const f = field();
    suggestName(f, 'Hekla');
    f.dispatchEvent(new Event('focus'));
    expect(f.selected).toBeNull();
    vi.runAllTimers();
    expect(f.selected).toEqual([0, 5]);
  });

  test('the tap\'s own caret placement is cancelled while the name is unchanged', () => {
    const f = field();
    suggestName(f, 'Hekla');
    const up = new Event('mouseup', { cancelable: true });
    f.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
  });

  test('once edited, a tap only places the caret', () => {
    const f = field();
    suggestName(f, 'Hekla');
    f.value = 'Hekla view';
    const up = new Event('mouseup', { cancelable: true });
    f.dispatchEvent(up);
    f.dispatchEvent(new Event('click'));
    expect([up.defaultPrevented, f.selected]).toEqual([false, null]);
  });

  test('a field reused for another name selects the new one, with one listener', () => {
    const f = field();
    const spy = vi.spyOn(f, 'setSelectionRange');
    suggestName(f, 'To Landmannalaugar');
    suggestName(f, 'Pin 64.1, -21.9');
    f.dispatchEvent(new Event('click'));
    expect(spy).toHaveBeenCalledOnce();
    expect(f.selected).toEqual([0, 15]);
  });
});
