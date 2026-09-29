import { describe, expect, test } from 'vitest';
import { GpxError, parseGpx } from '../src/gpx/parse';
import { climb, formatDistance, formatDuration, summarize } from '../src/gpx/stats';

const GPX11 = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Laugavegur &amp; Fimmvörðuháls</name></metadata>
  <wpt lat="63.9913" lon="-19.0605"><ele>590</ele><name>Landmannalaugar</name></wpt>
  <wpt lat="63.6300" lon="-19.4500"><name><![CDATA[Þórsmörk <Básar>]]></name></wpt>
  <trk><name>Day 1</name>
    <trkseg>
      <trkpt lat="63.9913" lon="-19.0605"><ele>590</ele><time>2026-07-01T09:00:00Z</time></trkpt>
      <trkpt lat="63.9950" lon="-19.0605"><ele>650</ele><time>2026-07-01T09:30:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat='63.9950' lon='-19.0500'><ele>640</ele><time>2026-07-01T10:00:00Z</time></trkpt>
      <trkpt lat='63.9960' lon='-19.0500'/>
    </trkseg>
  </trk>
  <rte><name>Plan</name><rtept lat="63.99" lon="-19.06"/><rtept lat="63.98" lon="-19.07"/></rte>
</gpx>`;

describe('parseGpx', () => {
  test('reads tracks (one line per segment), routes and waypoints, with names, heights and times', () => {
    const g = parseGpx(GPX11);
    expect(g.name).toBe('Laugavegur & Fimmvörðuháls');
    expect(g.waypoints).toEqual([
      { name: 'Landmannalaugar', lon: -19.0605, lat: 63.9913, ele: 590 },
      { name: 'Þórsmörk <Básar>', lon: -19.45, lat: 63.63, ele: null },
    ]);
    expect(g.lines.map((l) => [l.kind, l.name, l.points.length])).toEqual([['track', 'Day 1', 2], ['track', 'Day 1', 2], ['route', 'Plan', 2]]);
    expect(g.lines[0].points[1]).toEqual({ lon: -19.0605, lat: 63.995, ele: 650, time: Date.parse('2026-07-01T09:30:00Z') });
    expect(g.lines[1].points[1]).toEqual({ lon: -19.05, lat: 63.996, ele: null, time: null });
  });

  test('GPX 1.0 and namespace prefixes', () => {
    const g = parseGpx(`<gpx:gpx version="1.0" xmlns:gpx="http://www.topografix.com/GPX/1/0"><gpx:name>Old</gpx:name>
      <gpx:trk><gpx:trkseg><gpx:trkpt lat="64" lon="-21"/><gpx:trkpt lat="64.1" lon="-21"/></gpx:trkseg></gpx:trk></gpx:gpx>`);
    expect(g.name).toBe('Old');
    expect(g.lines[0].points.map((p) => p.lat)).toEqual([64, 64.1]);
  });

  test('skips points with bad coordinates and segments with fewer than two points', () => {
    const g = parseGpx(`<gpx><trk><trkseg><trkpt lat="x" lon="1"/><trkpt lat="64" lon="-21"/></trkseg>
      <trkseg><trkpt lat="64" lon="-21"/><trkpt lat="95" lon="-21"/><trkpt lat="64.2" lon="-21"/></trkseg></trk></gpx>`);
    expect(g.lines.map((l) => l.points.length)).toEqual([2]);
  });

  test('rejects files that are not GPX or hold nothing to draw', () => {
    expect(() => parseGpx('<kml></kml>')).toThrow(GpxError);
    expect(() => parseGpx('<gpx version="1.1"></gpx>')).toThrow(/no tracks, routes or waypoints/);
  });
});

describe('stats', () => {
  test('distance, climb and duration of a file', () => {
    const s = summarize(parseGpx(GPX11));
    // 0.0037° lat ≈ 411 m; 0.0105° lon at 64° ≈ 514 m is between segments (not counted); 0.001° lat ≈ 111 m;
    // route 0.01° lat + 0.01° lon ≈ 1112 + 488 → ~1214 m
    expect(s.distance).toBeGreaterThan(1700);
    expect(s.distance).toBeLessThan(1780);
    expect(s.climb).toBe(60);
    expect(s.duration).toBe(3600 * 1000);
  });

  test('climb ignores wobbles below the threshold but counts real climbs', () => {
    expect(climb([[100, 101, 100, 102, 101, 100]])).toBe(0);
    expect(climb([[100, 110, 105, 130]])).toBe(35); // 10 up, a real 5 m dip, then 25 up
    expect(climb([[100, 90, 120]])).toBe(30); // measured from the lowest point
    expect(climb([[null, 100, null, 150]])).toBe(50);
    expect(climb([[null, null]])).toBeNull();
  });

  test('formatting', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(5432)).toBe('5.4 km');
    expect(formatDistance(54210)).toBe('54 km');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration((5 * 60 + 20) * 60_000)).toBe('5 h 20 min');
    expect(formatDuration(30 * 3600_000)).toBe('1 day 6 h');
    expect(formatDuration(52 * 3600_000)).toBe('2 days');
  });
});
