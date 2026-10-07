import { describe, expect, test, vi } from 'vitest';
import type { Build } from '../src/buildInfo';
import { isNewer, UpdateWatcher, type Registration, type UpdateEnv } from '../src/app/updates';

const MINE: Build = { version: 'aaa1111', builtAt: '2026-10-01T10:00:00.000Z' };
const NEWER: Build = { version: 'bbb2222', builtAt: '2026-10-01T12:00:00.000Z' };
const OLDER: Build = { version: '9990000', builtAt: '2026-09-30T10:00:00.000Z' };

/** A fake browser: a registration that counts update checks, a controller holding `build`. */
function fakeEnv(build: Build | null = MINE) {
  const state = { build, online: true, updates: 0, failUpdate: false, newVersion: false, reloads: 0 };
  const hooks: { change?: () => void; shown?: () => void } = {};
  const reg: Registration = {
    update: async () => {
      state.updates++;
      if (state.failUpdate) throw new Error('offline');
      // The server has a newer sw.js: it starts installing.
      if (state.newVersion) reg.installing = {};
    },
  };
  const env: UpdateEnv = {
    register: async () => reg,
    controllerBuild: async () => state.build,
    onControllerChange: (fn) => (hooks.change = fn),
    online: () => state.online,
    onShown: (fn) => (hooks.shown = fn),
    reload: () => void state.reloads++,
  };
  return { env, state, hooks };
}

describe('isNewer', () => {
  test('only a newer build counts: not the same, an older one (a page fresher than its worker), dev or none', () => {
    expect(isNewer(NEWER, MINE)).toBe(true);
    expect(isNewer(MINE, MINE)).toBe(false);
    expect(isNewer(OLDER, MINE)).toBe(false);
    expect(isNewer({ ...NEWER, version: 'dev' }, MINE)).toBe(false);
    expect(isNewer(null, MINE)).toBe(false);
  });
});

describe('UpdateWatcher', () => {
  test('a newer version taking over is told once', async () => {
    const { env, state, hooks } = fakeEnv();
    const ready = vi.fn();
    await new UpdateWatcher(MINE, ready, env).start();
    expect(ready).not.toHaveBeenCalled();
    state.build = NEWER;
    hooks.change!();
    hooks.change!();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(ready).toHaveBeenCalledWith(NEWER);
  });

  test('a newer version already in control at start is told', async () => {
    const { env } = fakeEnv(NEWER);
    const ready = vi.fn();
    await new UpdateWatcher(MINE, ready, env).start();
    expect(ready).toHaveBeenCalledWith(NEWER);
  });

  test('checks when the app comes back into view, only online; a failed check is no error', async () => {
    const { env, state, hooks } = fakeEnv();
    await new UpdateWatcher(MINE, vi.fn(), env).start();
    state.online = false;
    hooks.shown!();
    expect(state.updates).toBe(0);
    state.online = true;
    state.failUpdate = true;
    hooks.shown!();
    expect(state.updates).toBe(1);
  });

  test('no more checks once a new version is found', async () => {
    const { env, state, hooks } = fakeEnv(NEWER);
    await new UpdateWatcher(MINE, vi.fn(), env).start();
    hooks.shown!();
    expect(state.updates).toBe(0);
  });

  test('no service worker: nothing happens', async () => {
    const { env, hooks } = fakeEnv(NEWER);
    env.register = async () => null;
    const ready = vi.fn();
    await new UpdateWatcher(MINE, ready, env).start();
    expect(ready).not.toHaveBeenCalled();
    expect(hooks.shown).toBeUndefined();
  });
});

describe('reloadFromServer', () => {
  test('nothing new on the server: asks, then reloads at once', async () => {
    const { env, state } = fakeEnv();
    const w = new UpdateWatcher(MINE, vi.fn(), env);
    await w.start();
    expect(await w.reloadFromServer()).toBe('reloading');
    expect([state.updates, state.reloads]).toEqual([1, 1]);
  });

  test('a newer version: reloads once it has installed and taken over', async () => {
    const { env, state, hooks } = fakeEnv();
    const w = new UpdateWatcher(MINE, vi.fn(), env);
    await w.start();
    state.newVersion = true;
    const done = w.reloadFromServer();
    await vi.waitFor(() => expect(state.updates).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.reloads).toBe(0); // still installing
    state.build = NEWER;
    hooks.change!();
    expect(await done).toBe('reloading');
    expect(state.reloads).toBe(1);
  });

  test('a new version that never takes over: reloads after the wait anyway', async () => {
    vi.useFakeTimers();
    const { env, state } = fakeEnv();
    const w = new UpdateWatcher(MINE, vi.fn(), env);
    await w.start();
    state.newVersion = true;
    const done = w.reloadFromServer();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBe('reloading');
    expect(state.reloads).toBe(1);
    vi.useRealTimers();
  });

  test('offline: changes nothing and says so; a failed check still reloads', async () => {
    const { env, state } = fakeEnv();
    const w = new UpdateWatcher(MINE, vi.fn(), env);
    await w.start();
    state.online = false;
    expect(await w.reloadFromServer()).toBe('offline');
    expect([state.updates, state.reloads]).toEqual([0, 0]);
    state.online = true;
    state.failUpdate = true; // the connection dropped mid-way: the page's own load goes to the network
    expect(await w.reloadFromServer()).toBe('reloading');
    expect(state.reloads).toBe(1);
  });
});
