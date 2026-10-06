import { describe, expect, test } from 'vitest';
import { isFreizeitkarte, splitTypeSuffix } from '../src/map/freizeitkarte';

describe('Freizeitkarte type suffixes', () => {
  test('recognises Freizeitkarte maps by their header name only', () => {
    expect(isFreizeitkarte('Freizeitkarte_ISL (Release 26.09)')).toBe(true);
    expect(isFreizeitkarte('Íslandskort GPSmap.is 2024.21 OruxMaps Detailed')).toBe(false);
    expect(isFreizeitkarte('OpenTopoMap Iceland 2026-05-24')).toBe(false);
  });

  test('a type in brackets becomes what the place is', () => {
    expect(splitTypeSuffix('Dettifoss (Waterfall)')).toEqual({ name: 'Dettifoss', what: 'Waterfall' });
    expect(splitTypeSuffix('Vínbúðin (Off Licence)')).toEqual({ name: 'Vínbúðin', what: 'Off licence' });
    expect(splitTypeSuffix('Hvítárnes (Church, Place of Worship)')).toEqual({ name: 'Hvítárnes', what: 'Church, place of worship' });
    // Only the last bracket is the type; earlier ones belong to the name.
    expect(splitTypeSuffix('Húsavík (Skjálfandi) (Harbour)')).toEqual({ name: 'Húsavík (Skjálfandi)', what: 'Harbour' });
  });

  test('a height becomes part of the name; unnamed peaks are named by their height', () => {
    expect(splitTypeSuffix('Hestur (455)')).toEqual({ name: 'Hestur 455 m' });
    expect(splitTypeSuffix('N.N. (747)')).toEqual({ name: '747 m' });
  });

  test('"(yes)" is dropped, unnamed places take their type as a name, plain names are kept', () => {
    expect(splitTypeSuffix('Verslunin Urð (yes)')).toEqual({ name: 'Verslunin Urð' });
    expect(splitTypeSuffix('N.N. (Shelter)')).toEqual({ name: 'Shelter', what: 'Shelter' });
    expect(splitTypeSuffix('N.N.')).toEqual({ name: null });
    expect(splitTypeSuffix('Kálfskarð')).toEqual({ name: 'Kálfskarð' });
  });
});
