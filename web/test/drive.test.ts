import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeBackup } from '../src/saved/backup';
import type { SavedPin } from '../src/saved/saved';
import { readSyncFile } from '../src/sync/drive';

const pin = (id: string): SavedPin => ({ id, kind: 'pin', name: id, added: 1, lon: -19, lat: 64 });

/** A fake Drive: the files listed (oldest first) and their contents; records what was asked. */
function drive(files: Array<{ id: string; version: string; body: string }>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const u = new URL(url);
    asked.push(u.pathname);
    if (u.pathname === '/drive/v3/files') return new Response(JSON.stringify({ files: files.map(({ id, version }) => ({ id, version })) }));
    const f = files.find((x) => u.pathname === `/drive/v3/files/${x.id}`);
    return f ? new Response(f.body) : new Response('', { status: 404 });
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('readSyncFile', () => {
  test('nothing is downloaded when the file is still the version this device left', async () => {
    const asked = drive([{ id: 'f1', version: '7', body: JSON.stringify(makeBackup([pin('a')], [])) }]);
    const r = await readSyncFile('token', '7');
    expect(r.unchanged).toBe(true);
    expect(asked).toEqual(['/drive/v3/files']);
  });

  test('two files (two devices first synced at once): the oldest is used, the other merged in and listed for removal', async () => {
    drive([
      { id: 'old', version: '3', body: JSON.stringify(makeBackup([pin('a')], [])) },
      { id: 'new', version: '1', body: JSON.stringify(makeBackup([pin('b')], [])) },
    ]);
    const r = await readSyncFile('token', '3');
    expect(r.unchanged).toBeUndefined();
    expect(r.id).toBe('old');
    expect(r.data!.saved.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(r.extra).toEqual(['new']);
  });
});
