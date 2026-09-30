/** Per-device preferences in localStorage; storage can be unavailable (private mode), so both
 *  sides fail soft to the default. */
export function readSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export function writeSetting(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // not remembered; the switch still works for this session
  }
}
