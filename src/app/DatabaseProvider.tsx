import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { resetSharedDatabase } from '../db/database.ts';
import { initializeDatabase, type InitializedDatabase } from '../db/initialize.ts';
import {
  DatabaseContext,
  type DatabaseContextValue,
  type DatabaseState,
} from '../shared/database-context.ts';

export type DatabaseInitializer = () => Promise<InitializedDatabase>;

const defaultInitializer: DatabaseInitializer = () => initializeDatabase();

export interface DatabaseProviderProps {
  /** Injectable so tests can exercise the failure and retry paths without a real fault. */
  initialize?: DatabaseInitializer;
  children: ReactNode;
}

/** A short label for the UI. Never includes record data or a raw stack trace. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return 'UnknownError';
}

export function DatabaseProvider({
  initialize = defaultInitializer,
  children,
}: DatabaseProviderProps): ReactNode {
  const [state, setState] = useState<DatabaseState>({ status: 'initializing' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void initialize().then(
      ({ db }) => {
        if (!cancelled) {
          setState({ status: 'ready', db });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', reason: describeFailure(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [initialize, attempt]);

  // Resetting to `initializing` belongs to the click, not the effect: an effect that
  // sets state synchronously causes a cascading render.
  const retry = useCallback(() => {
    resetSharedDatabase();
    setState({ status: 'initializing' });
    setAttempt((value) => value + 1);
  }, []);

  const value = useMemo<DatabaseContextValue>(() => ({ state, retry }), [state, retry]);

  return <DatabaseContext.Provider value={value}>{children}</DatabaseContext.Provider>;
}
