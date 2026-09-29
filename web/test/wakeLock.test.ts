import { describe, expect, test } from 'vitest';
import { ScreenAwake, type WakeLockApi } from '../src/location/wakeLock';

function fakes() {
  const log: string[] = [];
  let visible = true;
  const listeners: Array<() => void> = [];
  let n = 0;
  const api: WakeLockApi = {
    request: async () => {
      const id = ++n;
      log.push(`request ${id}`);
      return { release: async () => { log.push(`release ${id}`); } };
    },
  };
  const doc = {
    get visible() { return visible; },
    onVisibilityChange: (fn: () => void) => listeners.push(fn),
  };
  const setVisible = async (v: boolean) => { visible = v; listeners.forEach((fn) => fn()); await flush(); };
  return { api, doc, log, setVisible };
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
});
