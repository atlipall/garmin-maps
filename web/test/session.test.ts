import { describe, expect, test } from 'vitest';
import { parseSession, type Session } from '../src/app/session';

const session: Session = {
  map: 'Iceland Detailed.img',
  view: { center: [-19.06, 63.99], zoom: 11.5, bearing: 40 },
  location: { mode: 'heading', paused: false },
  route: { dest: { name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }, routed: true, from: null },
};

describe('parseSession', () => {
  test('a stored session comes back as it was', () => {
    expect(parseSession(JSON.stringify(session), session.map)).toEqual(session);
    const pin = { ...session, route: { dest: { name: null, lon: -19.3, lat: 64.2 }, routed: true, from: [-21, 64] as [number, number] } };
    expect(parseSession(JSON.stringify(pin), session.map)).toEqual(pin);
    expect(parseSession(JSON.stringify({ ...session, route: null }), session.map)?.route).toBeNull();
  });

  test('nothing for another map file, no session, broken JSON or a malformed one', () => {
    expect(parseSession(JSON.stringify(session), 'Other.img')).toBeNull();
    expect(parseSession(null, session.map)).toBeNull();
    expect(parseSession('{', session.map)).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, view: { center: [1], zoom: 3, bearing: 0 } }), session.map)).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, location: { mode: 'sideways', paused: false } }), session.map)).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, route: { dest: { lon: 1 }, routed: true, from: null } }), session.map)).toBeNull();
  });
});
