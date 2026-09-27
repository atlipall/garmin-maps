export const BACKGROUND = '#f4f0e4';

const WATER = '#a8d0ee';
const PARK = '#cde6b5';
export const POLYGON_COLORS = new Map<number, string>([
  [0x01, '#e3d7c5'], [0x02, '#e3d7c5'], [0x03, '#e3d7c5'], [0x04, '#d9d0c9'], [0x05, '#dddddd'], [0x06, '#dddddd'],
  [0x07, '#e0dcd8'], [0x08, '#e8d9c5'], [0x09, '#cfe0f0'], [0x0a, '#e8e0d0'], [0x0b, '#f0d8d8'], [0x0c, '#ddd5e8'],
  [0x0d, '#d8e8c8'], [0x0e, '#e0e0e0'], [0x13, '#d6c4ac'], [0x14, PARK], [0x15, PARK], [0x16, PARK],
  [0x17, '#d4ebbf'], [0x18, '#d4ebbf'], [0x19, '#dcebc9'], [0x1a, '#d0dcc8'], [0x1e, PARK], [0x1f, PARK], [0x20, PARK],
  [0x28, WATER], [0x29, WATER], [0x32, WATER], [0x3b, WATER], [0x3c, WATER], [0x3d, WATER], [0x3e, WATER],
  [0x3f, WATER], [0x40, WATER], [0x41, WATER], [0x42, WATER], [0x43, WATER], [0x44, WATER], [0x45, WATER],
  [0x46, WATER], [0x47, WATER], [0x48, WATER], [0x49, WATER], [0x4c, '#c4def0'], [0x4d, '#fbfdff'],
  [0x4e, '#dcebc0'], [0x4f, '#e0e8c8'], [0x50, '#b8dba0'], [0x51, '#c9e0d8'], [0x52, '#e6ecd6'], [0x53, '#f1e6c6'],
]);
/** 0x4A is the map coverage definition and 0x4B the background; drawn only if the TYP styles them. */
export const SKIP_POLYGONS = new Set([0x4a, 0x4b]);

type LineDef = [string, number, number[] | null];
const TRACK: LineDef = ['#a0703c', 1, [1, 1]];
export const LINE_STYLES = new Map<number, LineDef>([
  [0x01, ['#d4413a', 4, null]], [0x02, ['#e0662f', 3.5, null]], [0x03, ['#f0a040', 3, null]],
  [0x04, ['#f5c060', 2.5, null]], [0x05, ['#ffffff', 2, null]], [0x06, ['#ffffff', 1.5, null]],
  [0x07, ['#ffffff', 1, null]], [0x08, ['#f0a040', 2, null]], [0x09, ['#f0a040', 2, null]],
  [0x0a, ['#a0703c', 1.5, [2, 1]]], [0x0b, ['#f0a040', 2, null]], [0x0c, ['#ffffff', 1.5, null]],
  [0x0d, TRACK], [0x0e, TRACK], [0x0f, TRACK], [0x10, TRACK], [0x11, TRACK], [0x12, TRACK], [0x13, TRACK],
  [0x14, ['#555555', 1.5, [3, 2]]], [0x15, ['#4a86c5', 1, null]], [0x16, ['#c0392b', 1, [2, 1.5]]],
  [0x18, ['#4a86c5', 1, null]], [0x19, ['#999999', 1, [4, 2]]], [0x1a, ['#3c78d8', 1, [3, 2]]],
  [0x1b, ['#3c78d8', 1, [3, 2]]], [0x1c, ['#8e44ad', 1, [4, 2]]], [0x1d, ['#8e44ad', 1, [3, 2]]],
  [0x1e, ['#8e44ad', 1.5, [5, 2]]], [0x1f, ['#4a86c5', 2, null]], [0x20, ['#c8a07a', 0.5, null]],
  [0x21, ['#c8a07a', 0.7, null]], [0x22, ['#b08058', 1, null]], [0x23, ['#7fa7c9', 0.5, null]],
  [0x24, ['#7fa7c9', 0.7, null]], [0x25, ['#7fa7c9', 1, null]], [0x26, ['#4a86c5', 1, [2, 1]]],
  [0x27, ['#888888', 3, null]], [0x28, ['#777777', 1, [4, 2]]], [0x29, ['#888888', 1, null]],
  [0x2a, ['#4a86c5', 1, [4, 2]]], [0x2b, ['#d4413a', 1, [4, 2]]],
]);
export const DEFAULT_LINE: LineDef = ['#888888', 1, null];

const prio = (p: number, types: number[]) => types.map((t) => [t, p] as [number, number]);
/** Higher draws later (on top). */
export const LINE_PRIORITY = new Map<number, number>([
  ...prio(10, [0x20, 0x21, 0x22, 0x23, 0x24, 0x25]),
  ...prio(20, [0x15, 0x18, 0x1f, 0x26]),
  ...prio(30, [0x19, 0x1c, 0x1d, 0x1e, 0x2a, 0x2b]),
  ...prio(35, [0x28, 0x29]),
  ...prio(40, [0x14, 0x1a, 0x1b]),
  ...prio(50, [0x0a, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x16]),
  ...prio(60, [0x05, 0x06, 0x07, 0x0c]),
  ...prio(70, [0x01, 0x02, 0x03, 0x04, 0x08, 0x09, 0x0b]),
]);
export const DEFAULT_LINE_PRIORITY = 45;
