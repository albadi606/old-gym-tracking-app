import { useCallback, useRef, useState } from 'react';

/**
 * A write with a visible lifecycle.
 *
 * A tap that silently does nothing is the worst possible outcome at the gym: storage can
 * be full, the database can be busy, and a private window can refuse to persist at all.
 * In every one of those cases the user needs to be told, and needs a way to try again --
 * not a control that quietly springs back to where it was.
 *
 * The operation is remembered so `retry` can repeat exactly what failed, and `isPending`
 * lets callers disable their controls so an impatient second tap cannot start a duplicate
 * write.
 *
 * There are two ways to start a write, and the difference matters.
 *
 * - `run` **drops** a second call while one is in flight. That is the double-tap guard:
 *   the second tap asks for the same thing as the first, so doing it once is correct.
 * - `enqueue` **waits** for the in-flight write and then runs. That is for a genuinely
 *   different action arriving on the heels of the first -- most importantly, tapping a
 *   button while a field still has focus, where the resulting blur starts a save a
 *   fraction of a second before the button's own write. Dropping that one would leave a
 *   control that visibly did nothing.
 *
 * The pending state spans every outstanding operation rather than just the newest, so a
 * queued write never lets the interface flash "saved" while it is still running.
 */

export type MutationState =
  | { status: 'idle' }
  | { status: 'pending' }
  /** A short, non-identifying label. Record contents are never included. */
  | { status: 'error'; reason: string };

export interface Mutation {
  state: MutationState;
  isPending: boolean;
  hasFailed: boolean;
  /** Starts the operation, unless one is already running. */
  run: (operation: () => Promise<unknown>) => void;
  /** Starts the operation after any in-flight one settles. */
  enqueue: (operation: () => Promise<unknown>) => void;
  /**
   * `enqueue`, but the caller can wait for the result.
   *
   * A button that fires and forgets is right for a save the user is not waiting on. It is
   * wrong for a save something else depends on: finishing a workout has to know whether
   * the last field reached the database, and the returned promise rejects with whatever
   * the operation threw so the caller can stop rather than close the session anyway.
   */
  enqueueAsync: (operation: () => Promise<unknown>) => Promise<void>;
  retry: () => void;
  dismiss: () => void;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return 'UnknownError';
}

export function useMutation(onSuccess?: () => void): Mutation {
  const [state, setState] = useState<MutationState>({ status: 'idle' });
  const lastOperation = useRef<(() => Promise<unknown>) | undefined>(undefined);
  const pending = useRef(false);
  /** How many operations are still outstanding, so a queue cannot report idle early. */
  const outstanding = useRef(0);
  /** The tail of the queue. Each enqueued operation starts after this settles. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const start = useCallback(
    (operation: () => Promise<unknown>, mode: 'drop' | 'queue'): Promise<void> => {
      if (pending.current && mode === 'drop') {
        return Promise.resolve();
      }
      pending.current = true;
      outstanding.current += 1;
      lastOperation.current = operation;
      setState({ status: 'pending' });

      // Runs after the previous operation settles, whichever way it settled: a failed
      // save must not strand everything queued behind it.
      const run = chain.current.then(operation, operation);
      chain.current = run.then(
        () => undefined,
        () => undefined,
      );

      return run.then(
        () => {
          outstanding.current -= 1;
          if (outstanding.current === 0) {
            pending.current = false;
            setState({ status: 'idle' });
          }
          onSuccess?.();
        },
        (error: unknown) => {
          outstanding.current -= 1;
          if (outstanding.current === 0) {
            pending.current = false;
          }
          setState({ status: 'error', reason: describeFailure(error) });
          // Rethrown so a caller that waited can react. `run` and `enqueue` swallow it,
          // which is what keeps an unhandled rejection out of a fire-and-forget tap.
          throw error;
        },
      );
    },
    [onSuccess],
  );

  const run = useCallback(
    (operation: () => Promise<unknown>) => {
      void start(operation, 'drop').catch(() => undefined);
    },
    [start],
  );

  const enqueue = useCallback(
    (operation: () => Promise<unknown>) => {
      void start(operation, 'queue').catch(() => undefined);
    },
    [start],
  );

  const enqueueAsync = useCallback(
    (operation: () => Promise<unknown>) => start(operation, 'queue'),
    [start],
  );

  const retry = useCallback(() => {
    const operation = lastOperation.current;
    if (operation) {
      void start(operation, 'drop').catch(() => undefined);
    }
  }, [start]);

  const dismiss = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return {
    state,
    isPending: state.status === 'pending',
    hasFailed: state.status === 'error',
    run,
    enqueue,
    enqueueAsync,
    retry,
    dismiss,
  };
}
