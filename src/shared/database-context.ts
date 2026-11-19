import { createContext, useContext } from 'react';

import type { GymTrackerDatabase } from '../db/database.ts';

export type DatabaseState =
  | { status: 'initializing' }
  | { status: 'ready'; db: GymTrackerDatabase }
  /** `reason` is a short, non-identifying label. Record contents are never included. */
  | { status: 'error'; reason: string };

export interface DatabaseContextValue {
  state: DatabaseState;
  retry: () => void;
}

export const DatabaseContext = createContext<DatabaseContextValue>({
  state: { status: 'initializing' },
  retry: () => undefined,
});

export function useDatabaseState(): DatabaseContextValue {
  return useContext(DatabaseContext);
}
