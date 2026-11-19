import { useCallback, useRef } from 'react';

import type { Mutation } from '../../shared/useMutation.ts';

/**
 * How one workout card orders its writes: saves and button actions are not the same kind
 * of thing, and treating them as one kind lost data.
 *
 * Both cards used to guard every write with a single mutable key and drop anything whose
 * key was already outstanding. Every field blur asks for `save`, so the *second* blur
 * while the first save was still in flight was dropped as though it were a double tap.
 * It was not: it carried a later revision of the draft. Blurring reps `10` and then
 * weight `60` stored the reps and left the weight undefined, the card said "Not saved
 * yet", and nothing ever retried it -- so a reload lost a number the user had entered and
 * watched the app acknowledge.
 *
 * The same key had a second fault. It held one action name, so a different action queued
 * behind the first overwrote it, and then the *first* operation's `finally` cleared the
 * guard while the second was still running. No operation should depend on another
 * operation releasing its guard.
 *
 * So there are two channels, and the difference between them is the difference between
 * "do this again" and "do this instead".
 *
 * - **`runAction`** is for a lifecycle button -- complete, reopen, skip, remove. Tapping
 *   the same one twice asks for the same outcome, so the second is dropped. Each key is
 *   tracked separately, so a queued action can never be released by an earlier one
 *   finishing.
 * - **`saveDraft`** is for "make what is on screen durable", and it is identified by the
 *   draft it would write. A *different* revision is never dropped: it supersedes an older
 *   one that has not started yet, and queues behind one that has, so the newest revision
 *   is written last. The *same* revision, while that exact write is already outstanding,
 *   is a duplicate after all -- blurring a field and then pressing Save asks twice for one
 *   thing -- and is dropped.
 *
 * Ordering comes from `useMutation.enqueue`, so a save started by a blur still lands
 * before the button press that followed it, and the terminal flush still lands after
 * everything queued ahead of it.
 */

interface DraftSave {
  /** Identifies the draft this write would store. Equal keys are the same request. */
  revision: string;
  operation: () => Promise<unknown>;
}

export interface CardWrites {
  /** Runs a lifecycle action, unless the identical one is already outstanding. */
  runAction: (key: string, operation: () => Promise<unknown>) => void;
  /**
   * Claims an action key synchronously, returning false when it is already outstanding.
   *
   * For an action that cannot simply be enqueued -- one that has to await a flush first
   * and decide what to do with the result. The caller must release it.
   */
  beginAction: (key: string) => boolean;
  releaseAction: (key: string) => void;
  /**
   * Makes the current draft durable.
   *
   * `revision` identifies what would be written. A distinct revision always gets its turn;
   * a repeat of one already outstanding is dropped.
   */
  saveDraft: (revision: string, operation: () => Promise<unknown>) => void;
}

export function useCardWrites(mutation: Mutation): CardWrites {
  /** Every lifecycle key currently outstanding, so each releases only its own. */
  const outstanding = useRef(new Set<string>());
  /** The newest draft revision waiting for a turn. */
  const queuedSave = useRef<DraftSave | undefined>(undefined);
  /** The revision most recently started, so `mutation.retry` repeats a real write. */
  const startedSave = useRef<DraftSave | undefined>(undefined);
  /** The revision being written right now, so an identical request is a duplicate. */
  const inFlightRevision = useRef<string | undefined>(undefined);

  const beginAction = useCallback((key: string): boolean => {
    if (outstanding.current.has(key)) {
      return false;
    }
    outstanding.current.add(key);
    return true;
  }, []);

  const releaseAction = useCallback((key: string): void => {
    outstanding.current.delete(key);
  }, []);

  const runAction = useCallback(
    (key: string, operation: () => Promise<unknown>) => {
      if (!beginAction(key)) {
        return;
      }
      mutation.enqueue(async () => {
        try {
          await operation();
        } finally {
          releaseAction(key);
        }
      });
    },
    [mutation, beginAction, releaseAction],
  );

  const saveDraft = useCallback(
    (revision: string, operation: () => Promise<unknown>) => {
      const queued = queuedSave.current;
      /*
       * A request matching the write already in flight is a duplicate **only when nothing
       * different is waiting behind it.**
       *
       * Dropping it unconditionally was a stale-write race. Save A starts and is held; the
       * user changes a field, so B queues; the user changes it back, so A is requested
       * again -- and that third request, which is the newest truth on the screen, was
       * discarded merely because A happened to be the revision in flight. B then ran last
       * and won, so a value the user had just put back was overwritten by the one they had
       * moved away from, and it survived a reload.
       *
       * So the guard now asks the question it always meant to ask: "is this request
       * already the final answer?" It is only that when the in-flight write is this
       * revision *and* the queue holds nothing else.
       */
      if (
        revision === inFlightRevision.current &&
        (queued === undefined || queued.revision === revision)
      ) {
        return;
      }
      const alreadyQueued = queued !== undefined;
      /*
       * A newer revision replaces one that has not started: each save writes the whole
       * editable field set, so the later draft is a strictly better answer to the same
       * question. That includes replacing a queued B with a return to A -- writing A a
       * second time costs one redundant write of values that are already correct, and it
       * is what guarantees the user's newest draft is the durable one.
       */
      queuedSave.current = { revision, operation };
      if (alreadyQueued) {
        return;
      }
      mutation.enqueue(async () => {
        /*
         * `mutation.retry` repeats whatever operation it was last given, which is this
         * closure. Falling back to the revision this queue last started is what makes a
         * retry after a failed save write the same values again rather than nothing.
         */
        const next = queuedSave.current ?? startedSave.current;
        queuedSave.current = undefined;
        if (!next) {
          return;
        }
        startedSave.current = next;
        inFlightRevision.current = next.revision;
        try {
          await next.operation();
        } finally {
          inFlightRevision.current = undefined;
        }
      });
    },
    [mutation],
  );

  return { runAction, beginAction, releaseAction, saveDraft };
}
