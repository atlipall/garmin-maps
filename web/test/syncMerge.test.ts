import { describe, expect, test } from 'vitest';
import { makeBackup } from '../src/saved/backup';
import type { SavedPin } from '../src/saved/saved';
import { mergeFiles, planSync } from '../src/sync/merge';

const pin = (id: string, added: number, updated?: number): SavedPin => ({ id, kind: 'pin', name: id, added, lon: -19, lat: 64, ...(updated ? { updated } : {}) });
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe('planSync', () => {
  test('first sync: no file yet, everything here is uploaded, nothing changes here', () => {
    const p = planSync({ saved: [pin('a', 1)], tracks: [], deleted: {} }, null);
    expect([p.putSaved, p.removeSaved]).toEqual([[], []]);
    expect(ids(p.upload!.saved)).toEqual(['a']);
  });

  test('items from another device come here; ours go up; the newer copy wins', () => {
    const remote = makeBackup([pin('b', 2), pin('c', 3, 9)], []);
    const p = planSync({ saved: [pin('a', 1), pin('c', 3, 5)], tracks: [], deleted: {} }, remote);
    expect(ids(p.putSaved).sort()).toEqual(['b', 'c']);
    expect(p.putSaved.find((x) => x.id === 'c')!.updated).toBe(9);
    expect(ids(p.upload!.saved)).toEqual(['a', 'b', 'c']);
  });

  test('a deletion on either side removes the item on the other', () => {
    const remote = makeBackup([pin('a', 1), pin('b', 2)], [], { c: 50 });
    const p = planSync({ saved: [pin('a', 1), pin('b', 2), pin('c', 3)], tracks: [], deleted: { a: 40 } }, remote);
    expect(p.removeSaved.sort()).toEqual(['a', 'c']);
    expect(ids(p.upload!.saved)).toEqual(['b']);
    expect(p.upload!.deleted).toEqual({ a: 40, c: 50 });
  });

  test('an item changed after it was deleted elsewhere survives', () => {
    const p = planSync({ saved: [pin('a', 1, 100)], tracks: [], deleted: {} }, makeBackup([], [], { a: 50 }));
    expect(p.removeSaved).toEqual([]);
    expect(ids(p.upload!.saved)).toEqual(['a']);
  });

  test('nothing to upload when the file already matches', () => {
    const remote = makeBackup([pin('a', 1)], [], { x: 5 });
    const p = planSync({ saved: [pin('a', 1)], tracks: [], deleted: { x: 5 } }, remote);
    expect(p.upload).toBeNull();
    expect([p.putSaved, p.removeSaved]).toEqual([[], []]);
  });

  test('a time from the future (a device whose clock runs fast) is stored capped, so later edits win', () => {
    const now = new Date(1_000_000_000_000);
    const t = now.getTime();
    // Another device deleted "a" with its clock an hour fast: stored as now + 5 min, not an hour on.
    const first = planSync({ saved: [], tracks: [], deleted: {} }, makeBackup([], [], { a: t + 3_600_000 }), now);
    expect(first.upload!.deleted).toEqual({ a: t + 5 * 60_000 });
    // Ten minutes later "a" is saved again elsewhere: that edit wins over the capped deletion.
    const later = new Date(t + 10 * 60_000);
    const again = planSync({ saved: [pin('a', t + 8 * 60_000)], tracks: [], deleted: first.deleted }, first.upload, later);
    expect(again.removeSaved).toEqual([]);
    expect(ids(again.upload!.saved)).toEqual(['a']);
  });

  test('two sync files merge into one with both devices\' items', () => {
    const merged = mergeFiles(makeBackup([pin('a', 1)], []), makeBackup([pin('b', 2)], [], { c: 3 }));
    expect(ids(merged.saved).sort()).toEqual(['a', 'b']);
    expect(merged.deleted).toEqual({ c: 3 });
  });
});
