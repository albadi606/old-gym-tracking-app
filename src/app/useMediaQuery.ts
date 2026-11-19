import { useCallback, useSyncExternalStore } from 'react';

/** Above this width the shell shows a sidebar instead of a bottom bar. */
export const WIDE_LAYOUT_QUERY = '(min-width: 48rem)';

function supportsMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * Subscribes to a media query.
 *
 * Layout switches that change *markup* (bottom bar versus sidebar) are decided here
 * rather than by CSS alone, so the two navigation variants never both exist in the
 * accessibility tree at the same time.
 *
 * `useSyncExternalStore` is used deliberately: the match is read during render, so a
 * viewport that changed between render and commit cannot leave a stale layout behind.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!supportsMatchMedia()) {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => {
        list.removeEventListener('change', onStoreChange);
      };
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => (supportsMatchMedia() ? window.matchMedia(query).matches : false),
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
