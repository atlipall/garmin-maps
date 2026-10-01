import { describe, expect, test } from 'vitest';
import type { StoredTrack } from '../src/gpx/store';
import { backupFileName, makeBackup, parseBackup, toStore } from '../src/saved/backup';
import type { SavedPin } from '../src/saved/saved';

const pin = (id: string, added: number, updated?: number): SavedPin => ({ id, kind: 'pin', name: id, added, lon: -19, lat: 64, ...(updated ? { updated } : {}) });
const track: StoredTrack = { id: 't', name: 'Hike', color: '#d6249f', visible: true, added: 5, stats: { distance: 1000, climb: 10, duration: null } as StoredTrack['stats'], gpx: { name: 'Hike', lines: [], waypoints: [] } };

describe('backup files', () => {
  test('a backup reads back with its items', () => {
    const text = JSON.stringify(makeBackup([pin('a', 1)], [track], {}, new Date('2026-09-30T12:00:00Z')));
    const b = parseBackup(text);
    expect(b.saved.map((s) => s.id)).toEqual(['a']);
    expect(b.tracks.map((t) => t.id)).toEqual(['t']);
    expect(b.exported).toBe('2026-09-30T12:00:00.000Z');
  });

  test('other files are refused with a message; damaged items are left out', () => {
    expect(() => parseBackup('not json')).toThrow("This isn't a Garmin Map backup file.");
    expect(() => parseBackup('{"app":"other"}')).toThrow("This isn't a Garmin Map backup file.");
    expect(() => parseBackup(JSON.stringify({ ...makeBackup([], []), version: 2 }))).toThrow('newer version');
    const b = parseBackup(JSON.stringify({ ...makeBackup([pin('a', 1)], [track]), saved: [pin('a', 1), { id: 'x' }], tracks: [track, { id: 'y' }] }));
    expect([b.saved.length, b.tracks.length]).toEqual([1, 1]);
  });

  test('file name carries the date', () => {
    expect(backupFileName(new Date('2026-09-30T12:00:00Z'))).toBe('Garmin Map backup 2026-09-30.json');
  });
});

describe('toStore', () => {
  test('new items and ones changed later come in; older or equal copies do not', () => {
    const local = [pin('a', 1), pin('b', 1, 10)];
    const incoming = [pin('a', 1, 5), pin('b', 1, 8), pin('c', 2)];
    expect(toStore(local, incoming).map((x) => x.id)).toEqual(['a', 'c']);
    expect(toStore(local, [pin('a', 1)])).toEqual([]);
  });

  test('an item deleted after its last change stays deleted', () => {
    expect(toStore([], [pin('a', 1, 5), pin('b', 1, 5)], { a: 6, b: 4 }).map((x) => x.id)).toEqual(['b']);
  });
});

describe('isTrack', () => {
  test('checks a track all the way down: points, colour (a url() would be fetched), stats', async () => {
    const { isTrack } = await import('../src/saved/backup');
    const good = { ...track, gpx: { name: null, lines: [{ kind: 'track', name: null, points: [{ lon: -19, lat: 64, ele: null, time: null }] }], waypoints: [{ name: 'Hut', lon: -19, lat: 64, ele: 600 }] } };
    expect(isTrack(good)).toBe(true);
    expect(isTrack({ ...good, color: 'url(https://example.com/x)' })).toBe(false);
    expect(isTrack({ ...good, gpx: { ...good.gpx, lines: [{ kind: 'track', name: null }] } })).toBe(false);
    expect(isTrack({ ...good, gpx: { ...good.gpx, lines: [{ kind: 'track', name: null, points: [{ lon: 'x', lat: 64 }] }] } })).toBe(false);
    expect(isTrack({ ...good, stats: { distance: 'far' } })).toBe(false);
  });
});
