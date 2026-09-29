/** The locate button's modes: off, following with north up, following with heading up. Dragging
 *  the map pauses following (the position and height stay shown) until the next tap. */
export interface LocationState {
  mode: 'off' | 'north' | 'heading';
  paused: boolean;
}

export const INITIAL: LocationState = { mode: 'off', paused: false };

/** off → north up → heading up → north up …; a paused mode resumes as it was. */
export function tap(s: LocationState): LocationState {
  if (s.mode === 'off') return { mode: 'north', paused: false };
  if (s.paused) return { mode: s.mode, paused: false };
  return { mode: s.mode === 'north' ? 'heading' : 'north', paused: false };
}

export const dragged = (s: LocationState): LocationState => (s.mode === 'off' ? s : { ...s, paused: true });

/** The compass button: back to north up, following (or paused) as before. */
export const compassReset = (s: LocationState): LocationState => (s.mode === 'heading' ? { ...s, mode: 'north' } : s);

export const longPress = (): LocationState => INITIAL;
