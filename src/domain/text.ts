/**
 * Text normalization shared by everything the user can search.
 *
 * It started inside `catalog/search.ts` because the catalog was the only thing with a
 * search box. History searches too -- over session names and the machine and exercise
 * names recorded *at the time* -- and two copies of "what counts as the same text" would
 * eventually disagree about an accent or a double space, so the rule moved here while
 * that second caller was being written. `catalog/search.ts` re-exports it, so no existing
 * caller changed.
 */

/**
 * Normalizes text for comparison.
 *
 * `toLowerCase` alone would leave "Café" and "cafe" as different machines, so accents are
 * decomposed and stripped. Matching is deliberately forgiving: these are search boxes
 * used one-handed at the gym, not identifier lookups.
 */
export function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * `true` when the needle appears in any of the haystack terms.
 *
 * A blank needle matches everything, so an empty search box is never a filter.
 */
export function matchesAnyTerm(terms: readonly string[], search: string | undefined): boolean {
  const needle = normalizeForSearch(search ?? '');
  if (needle.length === 0) {
    return true;
  }
  return terms.some((term) => normalizeForSearch(term).includes(needle));
}
