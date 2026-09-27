const LETTERS: Record<string, string> = { þ: 'th', ð: 'd', æ: 'ae', ö: 'o', ø: 'o' };

/** Lower-case, Icelandic letters spelled out, diacritics dropped, punctuation → single spaces. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[þðæöø]/g, (c) => LETTERS[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
