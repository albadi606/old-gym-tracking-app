/**
 * Validation for references to app-owned static assets.
 *
 * A shipped machine photo is referenced by a path relative to the app's own origin.
 * Anything that could resolve somewhere else must be rejected here, because a stored
 * reference is rendered later without further review, and a request to another host
 * would break the promise that nothing about a workout leaves this device.
 *
 * The strategy is an allowlist, not a blocklist. Every character of a valid path must
 * come from a narrow ASCII set, which is why there is no separate rule for control
 * characters, ASCII spaces, Unicode whitespace such as U+00A0 or U+3000, right-to-left
 * overrides, backslashes, or scheme colons: none of them are in the set. Percent signs
 * are excluded too, so a single, double, or mixed encoding of a traversal never gets far
 * enough to need decoding -- there is nothing to decode.
 */

/** Characters a valid path may contain. Deliberately smaller than RFC 3986 allows. */
const ALLOWED_PATH_CHARACTERS = /^[A-Za-z0-9._/-]+$/;

const MIN_PATH_LENGTH = 2;
const MAX_PATH_LENGTH = 300;

/**
 * Roots the application actually serves assets from.
 *
 * Machine images are the only externally referenced catalog assets.
 */
export const STATIC_ASSET_ROOTS = ['/machines/'] as const;

function hasSafeSegments(candidate: string): boolean {
  const segments = candidate.slice(1).split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * `true` only for a same-origin path such as `/machines/low-row-station-01-thumb.webp`.
 *
 * Rejects absolute URLs, protocol-relative `//host` references (which look relative but
 * are not), backslash paths, `..` traversal, percent-encoded traversal, empty segments,
 * and any character outside the narrow ASCII set above.
 */
export function isAppRelativeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length < MIN_PATH_LENGTH || value.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return false;
  }
  if (!ALLOWED_PATH_CHARACTERS.test(value)) {
    return false;
  }
  return hasSafeSegments(value);
}

/**
 * `true` only for an app-relative path under a root this application actually serves.
 *
 * Stored static references go through this rather than the general check: a shipped
 * asset that is not under a known root is a mistake worth catching at the boundary,
 * long before a broken image appears in the catalog.
 */
export function isStaticAssetPath(value: unknown): value is string {
  if (!isAppRelativeAssetPath(value)) {
    return false;
  }
  return STATIC_ASSET_ROOTS.some((root) => value.startsWith(root) && value.length > root.length);
}
