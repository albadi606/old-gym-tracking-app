import { useCallback } from 'react';

/**
 * Points an `<img>` at a stored Blob, and revokes the URL the moment it stops being
 * rendered.
 *
 * Every `createObjectURL` pins its Blob in memory until it is revoked, so a catalog that
 * scrolls through user photos would otherwise hold the whole set. This is done with a
 * callback ref that returns a cleanup rather than with state and an effect: creating the
 * URL is the act of attaching to the element, and tying the revoke to the same callback
 * means the two can never drift apart. It also keeps the component free of a state update
 * that exists only to carry a value the DOM already has.
 *
 * Returns `undefined` when there is no Blob, so callers can render a static `src` or a
 * placeholder instead. If minting the URL fails -- a browser with object URLs disabled,
 * or storage revoked underneath us -- `onFailure` is called so the caller can show its
 * "photo could not be displayed" state rather than an element that silently never loads.
 */
export function useBlobImageRef(
  blob: Blob | undefined,
  onFailure?: () => void,
): ((element: HTMLImageElement | null) => (() => void) | undefined) | undefined {
  const attach = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element || !blob) {
        return undefined;
      }
      let url: string;
      try {
        if (typeof URL.createObjectURL !== 'function') {
          throw new TypeError('Object URLs are unavailable');
        }
        url = URL.createObjectURL(blob);
      } catch {
        onFailure?.();
        return undefined;
      }
      element.src = url;
      return () => {
        URL.revokeObjectURL(url);
      };
    },
    [blob, onFailure],
  );

  return blob ? attach : undefined;
}
