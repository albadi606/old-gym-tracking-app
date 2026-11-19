import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { type Mutation, useMutation } from '../../shared/useMutation.ts';
import { type CardWrites, useCardWrites } from './useCardWrites.ts';

/**
 * The coordinator on its own, driven by the real `useMutation` it is built on.
 *
 * Both workout cards route every write through this hook, so the ordering rules are
 * tested here once rather than inferred twice from what a card happened to render. The
 * card tests still exist and still hold: they prove the rules reach a real form and a real
 * database. These prove the rules themselves, including the orderings a card cannot be
 * made to produce reliably.
 *
 * The rule the round-2 repair turns on: **a request matching the write in flight is a
 * duplicate only when nothing different is waiting behind it.** Save A starts and is held;
 * a change queues B; the user changes back to A. That third request is the newest truth on
 * the screen, and dropping it merely because A was in flight let stale B run last and win.
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      settle();
    };
  });
  return { promise, resolve };
}

interface Harness {
  mutation: Mutation;
  writes: CardWrites;
}

function renderCoordinator(): ReturnType<typeof renderHook<Harness, void>> {
  return renderHook<Harness, void>(() => {
    const mutation = useMutation();
    return { mutation, writes: useCardWrites(mutation) };
  });
}

/** Records the order writes actually completed in. */
function recorder(): {
  log: string[];
  write: (label: string, wait?: Promise<void>) => () => Promise<void>;
} {
  const log: string[] = [];
  return {
    log,
    write: (label: string, wait?: Promise<void>) => async (): Promise<void> => {
      if (wait) {
        await wait;
      }
      log.push(label);
    },
  };
}

/**
 * Makes one request and then lets the queue advance.
 *
 * The call itself is synchronous; the second `act` flushes the microtask that actually
 * starts an enqueued operation, which is what makes "in flight" mean something here.
 */
async function request(run: () => void): Promise<void> {
  act(run);
  await act(async () => {
    await Promise.resolve();
  });
}

async function drain(result: { current: Harness }): Promise<void> {
  await waitFor(() => {
    expect(result.current.mutation.isPending).toBe(false);
  });
}

describe('a save that returns to the revision already in flight', () => {
  it('supersedes the queued revision instead of being dropped', async () => {
    const { log, write } = recorder();
    const held = deferred();
    const { result } = renderCoordinator();

    // A starts and is held open.
    await request(() => {
      result.current.writes.saveDraft('A', write('A', held.promise));
    });

    // The user changes a field, so a different revision queues behind it.
    await request(() => {
      result.current.writes.saveDraft('B', write('B'));
    });

    // The user changes it back. This is the newest truth on the screen, and the old guard
    // discarded it because A was still the revision in flight.
    await request(() => {
      result.current.writes.saveDraft('A', write('A-again'));
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await drain(result);

    // The last write is the user's latest draft, and stale B never ran at all.
    expect(log).toEqual(['A', 'A-again']);
    expect(log).not.toContain('B');
  });

  it('still writes once when nothing different is queued', async () => {
    const { log, write } = recorder();
    const held = deferred();
    const { result } = renderCoordinator();

    await request(() => {
      result.current.writes.saveDraft('A', write('A', held.promise));
    });
    // Blurring a field and then pressing Save is one request made twice.
    await request(() => {
      result.current.writes.saveDraft('A', write('A-duplicate'));
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await drain(result);

    expect(log).toEqual(['A']);
  });

  it('drops a further repeat once the return to A is already queued', async () => {
    const { log, write } = recorder();
    const held = deferred();
    const { result } = renderCoordinator();

    await request(() => {
      result.current.writes.saveDraft('A', write('A', held.promise));
    });
    await request(() => {
      result.current.writes.saveDraft('B', write('B'));
    });
    await request(() => {
      result.current.writes.saveDraft('A', write('A-again'));
    });
    // A is in flight and A is queued, so this one really is a duplicate.
    await request(() => {
      result.current.writes.saveDraft('A', write('A-third'));
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await drain(result);

    expect(log).toEqual(['A', 'A-again']);
  });
});

describe('ordinary queueing, unchanged by the repair', () => {
  it('runs a different queued revision last', async () => {
    const { log, write } = recorder();
    const held = deferred();
    const { result } = renderCoordinator();

    await request(() => {
      result.current.writes.saveDraft('A', write('A', held.promise));
    });
    await request(() => {
      result.current.writes.saveDraft('B', write('B'));
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await drain(result);

    expect(log).toEqual(['A', 'B']);
  });

  it('keeps only the newest of several revisions queued behind one write', async () => {
    const { log, write } = recorder();
    const held = deferred();
    const { result } = renderCoordinator();

    await request(() => {
      result.current.writes.saveDraft('A', write('A', held.promise));
    });
    await request(() => {
      result.current.writes.saveDraft('B', write('B'));
    });
    await request(() => {
      result.current.writes.saveDraft('C', write('C'));
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await drain(result);

    // Each save writes the whole editable field set, so the later draft is a strictly
    // better answer to the same question and B has nothing left to contribute.
    expect(log).toEqual(['A', 'C']);
  });
});

describe('retrying after a failed save', () => {
  it('repeats the latest revision, once, rather than an older one', async () => {
    const log: string[] = [];
    const held = deferred();
    let failNext = true;
    const { result } = renderCoordinator();

    await request(() => {
      result.current.writes.saveDraft('A', async () => {
        await held.promise;
        log.push('A');
      });
    });
    // B queues behind A and is the one that fails.
    await request(() => {
      result.current.writes.saveDraft('B', () => {
        if (failNext) {
          failNext = false;
          log.push('B-failed');
          return Promise.reject(new Error('quota'));
        }
        log.push('B');
        return Promise.resolve();
      });
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await waitFor(() => {
      expect(result.current.mutation.hasFailed).toBe(true);
    });
    expect(log).toEqual(['A', 'B-failed']);

    await request(() => {
      result.current.mutation.retry();
    });
    await drain(result);

    // The retry repeats the revision that failed -- the user's latest -- and nothing else.
    expect(log).toEqual(['A', 'B-failed', 'B']);
  });
});

describe('lifecycle actions', () => {
  it('drops an identical action while it is outstanding, and releases only its own key', async () => {
    const { log, write } = recorder();
    const held = deferred();
    const { result } = renderCoordinator();

    await request(() => {
      result.current.writes.runAction('complete', write('complete', held.promise));
    });
    // The same button tapped twice asks for the same outcome.
    await request(() => {
      result.current.writes.runAction('complete', write('complete-again'));
    });
    // A different action is a real request and queues.
    await request(() => {
      result.current.writes.runAction('reopen', write('reopen'));
    });

    await act(async () => {
      held.resolve();
      await held.promise;
    });
    await drain(result);

    expect(log).toEqual(['complete', 'reopen']);

    // Each key was released by its own operation, so the same action can run again.
    await request(() => {
      result.current.writes.runAction('complete', write('complete-later'));
    });
    await drain(result);
    expect(log).toEqual(['complete', 'reopen', 'complete-later']);
  });

  it('claims and releases a key for an action that has to await something first', () => {
    const { result } = renderCoordinator();

    expect(result.current.writes.beginAction('remove')).toBe(true);
    // A second tap is refused while the first is outstanding.
    expect(result.current.writes.beginAction('remove')).toBe(false);
    // A different destructive action is not blocked by it.
    expect(result.current.writes.beginAction('skip')).toBe(true);

    act(() => {
      result.current.writes.releaseAction('remove');
    });
    expect(result.current.writes.beginAction('remove')).toBe(true);
    expect(result.current.writes.beginAction('skip')).toBe(false);
  });
});
