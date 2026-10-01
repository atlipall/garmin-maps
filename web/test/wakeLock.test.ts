import { describe, expect, test } from 'vitest';
import { ScreenAwake, type WakeLockApi } from '../src/location/wakeLock';

function fakes() {
  const log: string[] = [];
  let visible = true;
  const listeners: Array<() => void> = [];
  let n = 0;
  const api: WakeLockApi = {
    request: async () => {
      if (refuse > 0) {
        refuse--;
        log.push('refused');
        throw new Error('NotAllowedError');
      }
      const id = ++n;
      log.push(`request ${id}`);
      return { release: async () => { log.push(`release ${id}`); } };
    },
  };
  const touches: Array<() => void> = [];
  let refuse = 0;
  const doc = {
    get visible() { return visible; },
    onVisibilityChange: (fn: () => void) => listeners.push(fn),
    onTouch: (fn: () => void) => touches.push(fn),
  };
  const setVisible = async (v: boolean) => { visible = v; listeners.forEach((fn) => fn()); await flush(); };
  const touch = async () => { touches.forEach((fn) => fn()); await flush(); };
  return { api, doc, log, setVisible, touch, refuseNext: (k: number) => { refuse = k; } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ScreenAwake', () => {
  test('holds a lock only while wanted, and releases it when no longer wanted', async () => {
    const f = fakes();
    const awake = new ScreenAwake(f.api, f.doc);
    awake.setWanted(true); await flush();
    awake.setWanted(true); await flush(); // no second request
    awake.setWanted(false); await flush();
    expect(f.log).toEqual(['request 1', 'release 1']);
  });

  test('re-acquires when the app comes back to the foreground (iOS drops the lock when hidden)', async () => {
    const f = fakes();
    const awake = new ScreenAwake(f.api, f.doc);
    awake.setWanted(true); await flush();
    await f.setVisible(false); // the system released it; we only forget it
    await f.setVisible(true);
    expect(f.log).toEqual(['request 1', 'request 2']);
    awake.setWanted(false); await flush();
    await f.setVisible(false);
    await f.setVisible(true);
    expect(f.log).toEqual(['request 1', 'request 2', 'release 2']);
  });

  test('without the API, or when a request is refused, nothing throws', async () => {
    const none = new ScreenAwake(null, fakes().doc);
    none.setWanted(true); await flush();
    const f = fakes();
    const refused = new ScreenAwake({ request: async () => { throw new Error('NotAllowedError'); } }, f.doc);
    refused.setWanted(true); await flush();
    refused.setWanted(false); await flush();
    expect(none.supported).toBe(false);
  });

  test('a refused request (no tap yet, at startup) is tried again on the next touch', async () => {
    const f = fakes();
    f.refuseNext(1);
    const awake = new ScreenAwake(f.api, f.doc);
    awake.setWanted(true); await flush();
    await f.touch();
    await f.touch(); // already held: no new request
    expect(f.log).toEqual(['refused', 'request 1']);
  });
});
