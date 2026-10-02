import { storageName } from '../channel';

/** Saved items and tracks deleted on this device (id → when, ms), kept so a deletion reaches other
 *  devices when syncing. localStorage: small, and storage can be unavailable (fail soft). */
const KEY = storageName('deleted');

export function deletions(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function setDeletions(d: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // not remembered: the deletion just won't reach other devices
  }
}

export function noteDeleted(id: string, at = Date.now()): void {
  setDeletions({ ...deletions(), [id]: at });
}
