import { useCallback, useEffect, useRef, useState } from 'react';

import type { GymTrackerDatabase } from '../db/database.ts';
import { useDatabaseState } from './database-context.ts';

/**
 * Reads from the database once it is open, and again on demand.
 *
 * Feature components use this instead of touching Dexie: the loader they pass is a
 * repository call, so no component ever builds its own query. The three states are
 * explicit because "no data yet" and "the database failed to open" must never render the
 * same empty screen -- an app that silently shows nothing after a storage failure looks
 * exactly like an app that lost your history.
 *
 * The result is stored together with the database instance it came from. That is what
 * lets the hook report `loading` while the database is still opening, and after a retry
 * replaces the instance, without ever briefly showing one database's rows as if they
 * belonged to another.
 *
 * ## Why a read is cancelled synchronously
 *
 * `reload()` is the caller saying "what you are reading is already out of date". Tying
 * that to the effect's cleanup made it true only once React had re-rendered, and a read
 * that resolved inside that window still reached `setSnapshot` -- so the screen could go
 * *backwards* to rows a later write had already replaced.
 *
 * That was durable data loss one layer up. The workout cards adopt an incoming record
 * only while the user holds no unacknowledged edit, which is correct; a record arriving
 * from before the last save satisfied that rule perfectly and repopulated the field with a
 * superseded value, and the entry typed over it was appended to the value that came back
 * (`10` then `14` reloading as `1014`). The generation counter is therefore a ref, bumped
 * inside `reload` before anything is scheduled, and a read that started under an older
 * generation is discarded however it resolves.
 */

export type QueryState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  /** A short, non-identifying label. Record contents are never included. */
  | { status: 'error'; reason: string };

export interface QueryResult<T> {
  state: QueryState<T>;
  /** Re-runs the loader, e.g. after a write. */
  reload: () => void;
}

interface Snapshot<T> {
  source: GymTrackerDatabase | undefined;
  state: QueryState<T>;
}

const LOADING = { status: 'loading' } as const;

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return 'UnknownError';
}

export function useDatabaseQuery<T>(
  load: (db: GymTrackerDatabase) => Promise<T>,
  deps: readonly unknown[] = [],
): QueryResult<T> {
  const { state: dbState } = useDatabaseState();
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ source: undefined, state: LOADING });
  const [attempt, setAttempt] = useState(0);
  /**
   * How many times the caller has said the current read is out of date.
   *
   * A ref, and incremented inside `reload` rather than in the effect it schedules,
   * because `reload` is called from a write that has already changed the rows. Waiting
   * for React to re-render before invalidating leaves a window in which a read taken
   * before that write can still land and put the older rows on screen.
   */
  const generation = useRef(0);

  const db = dbState.status === 'ready' ? dbState.db : undefined;

  useEffect(() => {
    if (!db) {
      // The shell already reports an unopenable database; do not report it twice.
      return;
    }
    const startedAt = generation.current;
    let cancelled = false;
    /** Superseded by a later `reload`, or by this effect being cleaned up. */
    const isCurrent = (): boolean => !cancelled && startedAt === generation.current;
    void load(db).then(
      (data) => {
        if (isCurrent()) {
          setSnapshot({ source: db, state: { status: 'ready', data } });
        }
      },
      (error: unknown) => {
        if (isCurrent()) {
          setSnapshot({ source: db, state: { status: 'error', reason: describeFailure(error) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is intentionally not a dependency: callers pass an inline closure, and the
    // values it actually depends on are listed in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, attempt, ...deps]);

  const reload = useCallback(() => {
    generation.current += 1;
    setAttempt((value) => value + 1);
  }, []);

  const state = db !== undefined && snapshot.source === db ? snapshot.state : LOADING;
  return { state, reload };
}
