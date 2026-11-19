import { type ReactNode, useCallback, useMemo, useRef } from 'react';

import { RouteFocusContext } from './route-focus.ts';

/**
 * Coordinates focus between the persistent shell and pages that may arrive later from a
 * lazy chunk.
 *
 * The first ready page is a direct load, so it keeps the browser's normal starting focus
 * and leaves the skip link as the first Tab stop. Every later ready location is an SPA
 * transition (including Back/Forward), so its heading receives focus once its code has
 * actually rendered. A route may replace its loading Page with its final Page under one
 * location key; Page calls this again when that heading changes, so focus finishes on the
 * real content rather than a discarded placeholder.
 */
export function RouteFocusProvider({
  locationKey,
  children,
}: {
  locationKey: string;
  children: ReactNode;
}): ReactNode {
  const initialLocationKey = useRef(locationKey);
  const navigationOccurred = useRef(false);

  const focusReadyRoute = useCallback(
    (_locationKey: string, heading: HTMLHeadingElement): void => {
      /* Called from Page's layout effect, never while rendering. */
      if (locationKey !== initialLocationKey.current) {
        navigationOccurred.current = true;
      }
      if (navigationOccurred.current) {
        heading.focus();
      }
    },
    [locationKey],
  );

  const value = useMemo(() => ({ focusReadyRoute }), [focusReadyRoute]);
  return <RouteFocusContext value={value}>{children}</RouteFocusContext>;
}
