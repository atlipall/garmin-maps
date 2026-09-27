import { describe, expect, test } from 'vitest';
import { LEGACY_DIR, parseMeta, parsePointer, resolveCurrentDir, type LayoutAdapter } from '../src/storage/layout';

/** A fake storage: dir name → whether it holds a complete map. */
function fake(pointer: string | null, dirs: Record<string, boolean>): LayoutAdapter & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    pointerText: async () => pointer,
    dirs: async () => Object.keys(dirs),
    isComplete: async (d) => {
      checked.push(d);
      return dirs[d] ?? false;
    },
  };
}
const ptr = (dir: string) => JSON.stringify({ dir });

describe('resolveCurrentDir', () => {
  test('a valid pointer to a complete dir wins, even over newer complete dirs', async () => {
    const io = fake(ptr('garmin-100'), { 'garmin-100': true, 'garmin-200': true, garmin: true });
    expect(await resolveCurrentDir(io)).toBe('garmin-100');
    expect(io.checked).toEqual(['garmin-100']);
  });

  test('an empty pointer (created but never written) falls back to the newest complete dir', async () => {
    expect(await resolveCurrentDir(fake('', { 'garmin-100': true, 'garmin-200': true, garmin: true }))).toBe('garmin-200');
  });

  test('an unparseable / torn pointer falls back', async () => {
    // e.g. a shorter pointer written over a longer one, then interrupted before the truncate
    const torn = `${ptr('garmin-100')}0"}`;
    expect(parsePointer(torn)).toBeNull();
    expect(await resolveCurrentDir(fake(torn, { 'garmin-100': true, 'garmin-50': true }))).toBe('garmin-100');
    expect(await resolveCurrentDir(fake('{"dir":"garm', { 'garmin-100': true }))).toBe('garmin-100');
    expect(await resolveCurrentDir(fake(ptr('../etc'), { 'garmin-100': true }))).toBe('garmin-100');
  });

  test('a pointer naming a missing dir falls back', async () => {
    expect(await resolveCurrentDir(fake(ptr('garmin-300'), { 'garmin-100': true }))).toBe('garmin-100');
  });

  test('a pointer naming an incomplete dir falls back', async () => {
    expect(await resolveCurrentDir(fake(ptr('garmin-300'), { 'garmin-300': false, 'garmin-100': true }))).toBe('garmin-100');
  });

  test('the fallback picks the newest complete dir over a newer incomplete one', async () => {
    const dirs = { 'garmin-100': true, 'garmin-900': false, 'garmin-500': true, 'garmin-500-1': true, garmin: true };
    expect(await resolveCurrentDir(fake(null, dirs))).toBe('garmin-500-1');
    // numeric, not lexicographic: 1000 is newer than 900
    expect(await resolveCurrentDir(fake(null, { 'garmin-900': true, 'garmin-1000': true }))).toBe('garmin-1000');
  });

  test('legacy fallback: no pointer and no complete versioned dir', async () => {
    expect(await resolveCurrentDir(fake(null, { garmin: true }))).toBe(LEGACY_DIR);
    expect(await resolveCurrentDir(fake('', { garmin: true, 'garmin-900': false }))).toBe(LEGACY_DIR);
    expect(await resolveCurrentDir(fake(null, { garmin: false, 'garmin-900': false }))).toBeNull();
    expect(await resolveCurrentDir(fake(null, {}))).toBeNull();
  });

  test('non-map directories are ignored', async () => {
    expect(await resolveCurrentDir(fake(null, { other: true, 'garmin-x': true }))).toBeNull();
  });
});

describe('parseMeta', () => {
  test('rejects empty, corrupt and unknown-version meta', () => {
    expect(parseMeta(null)).toBeNull();
    expect(parseMeta('')).toBeNull();
    expect(parseMeta('{"version":1,')).toBeNull();
    expect(parseMeta('{"version":2,"imgSize":1,"hgtNames":[]}')).toBeNull();
    expect(parseMeta('{"version":1,"imgSize":1,"hgtNames":[]}')).toMatchObject({ imgSize: 1 });
  });
});
