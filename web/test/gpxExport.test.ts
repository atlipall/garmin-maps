import { describe, expect, test } from 'vitest';
import { gpxFileName, routeGpx, type RouteExport } from '../src/gpx/export';
import { parseGpx } from '../src/gpx/parse';

const r: RouteExport = {
  name: 'To Landmannalaugar & back <1>',
  summary: '139 km · 2 h 18 min · via 1 waypoint',
  route: {
    status: 'ok',
    coords: [[-21.0, 63.936], [-20.4, 63.84], [-19.06, 63.99]],
    metres: 139_000,
    seconds: 8280,
    offRoadStart: [[-21.0005, 63.9365], [-21.0, 63.936]],
    offRoadEnd: [[-19.06, 63.99], [-19.061, 63.991]],
    offRoadStartM: 40,
    offRoadEndM: 110,
  },
  start: [-21.0005, 63.9365],
  vias: [{ name: null, near: 'Hella', lon: -20.4, lat: 63.84 }],
  dest: { name: 'Landmannalaugar', lon: -19.061, lat: 63.991 },
};

describe('routeGpx', () => {
  test('reads back as a track from the chosen start to the destination, with named stops', () => {
    const gpx = parseGpx(routeGpx(r, new Date('2026-09-30T12:00:00Z')));
    expect(gpx.name).toBe('To Landmannalaugar & back <1>');
    expect(gpx.lines).toHaveLength(1);
    const pts = gpx.lines[0].points.map((p) => [p.lon, p.lat]);
    expect(pts[0]).toEqual([-21.0005, 63.9365]); // the off-road leg at the start
    expect(pts.slice(1, 4)).toEqual(r.route.coords);
    expect(pts[4]).toEqual([-19.061, 63.991]); // …and at the end
    expect(gpx.waypoints.map((w) => w.name)).toEqual(['Start', 'Waypoint 1: Hella', 'Landmannalaugar']);
  });
});

describe('gpxFileName', () => {
  test('keeps letters of any script, drops characters file systems dislike', () => {
    expect(gpxFileName('To Þórisvatn / F26?')).toBe('To Þórisvatn F26.gpx');
    expect(gpxFileName('***')).toBe('Route.gpx');
  });
});
