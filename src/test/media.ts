/**
 * A controllable `window.matchMedia`.
 *
 * The shell decides between the bottom bar and the sidebar in JavaScript, so tests need
 * to drive that decision directly rather than hoping a stylesheet was applied.
 */
type Predicate = (query: string) => boolean;

interface StubList {
  query: string;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  matches: boolean;
}

let predicate: Predicate = () => false;
const lists = new Map<string, StubList>();

function makeList(query: string): StubList {
  const existing = lists.get(query);
  if (existing) {
    return existing;
  }
  const created: StubList = { query, listeners: new Set(), matches: predicate(query) };
  lists.set(query, created);
  return created;
}

export function installMatchMediaStub(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const list = makeList(query);
      list.matches = predicate(query);
      return {
        get matches() {
          return list.matches;
        },
        media: query,
        onchange: null,
        addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
          if (type === 'change') {
            list.listeners.add(listener);
          }
        },
        removeEventListener: (
          type: string,
          listener: (event: MediaQueryListEvent) => void,
        ): void => {
          if (type === 'change') {
            list.listeners.delete(listener);
          }
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    },
  });
}

/** Replaces the predicate and notifies anything already subscribed. */
export function setMatchMedia(next: Predicate): void {
  predicate = next;
  for (const list of lists.values()) {
    const matches = predicate(list.query);
    if (matches !== list.matches) {
      list.matches = matches;
      for (const listener of list.listeners) {
        listener({ matches, media: list.query } as MediaQueryListEvent);
      }
    }
  }
}

export function resetMatchMedia(): void {
  predicate = () => false;
  lists.clear();
}
