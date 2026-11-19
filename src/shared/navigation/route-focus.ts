import { createContext, useContext } from 'react';

export interface RouteFocusContextValue {
  focusReadyRoute: (locationKey: string, heading: HTMLHeadingElement) => void;
}

export const RouteFocusContext = createContext<RouteFocusContextValue>({
  /* Isolated Page tests do not need to recreate the persistent app shell. */
  focusReadyRoute: () => undefined,
});

export function useRouteFocus(): RouteFocusContextValue {
  return useContext(RouteFocusContext);
}
