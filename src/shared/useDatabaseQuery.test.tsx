import { act, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it } from 'vitest';

import type { GymTrackerDatabase } from '../db/database.ts';
import { DatabaseContext, type DatabaseContextValue } from './database-context.ts';
import { useDatabaseQuery } from './useDatabaseQuery.ts';

/**
 * A read that has been superseded must never reach the screen.
 *
 * `reload()` is a caller saying "the rows you are reading have already changed". Tying
 * that to the effect's cleanup made it true only once React had re-rendered, so a read
 * taken *before* the write could still resolve inside that window and put the older rows
 * back. That is not a cosmetic flicker: the workout cards follow the record they are
 * given, and a record from before the last save satisfied every ownership rule they have.
 * It repopulated the field with a superseded value, and the next entry typed over it was
 * appended to what had come back -- `10` then `14` reloading as `1014`.
 */

const fakeDatabase = {} as GymTrackerDatabase;

interface Deferred {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  // Nothing awaits this promise directly; the hook's own handler is the only consumer.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

interface Harness {
  reload: () => void;
}

function Probe({ load, onReady }: { load: () => Promise<string>; onReady: (h: Harness) => void }) {
  // Passed straight through rather than wrapped in another `async`: an extra microtask
  // hop between the read resolving and the hook seeing it would move the very ordering
  // this file exists to pin.
  const { state, reload } = useDatabaseQuery(() => load());
  onReady({ reload });
  return (
    <p data-testid="value">
      {state.status === 'ready' ? state.data : state.status === 'error' ? 'failed' : 'loading'}
    </p>
  );
}

function renderProbe(load: () => Promise<string>): Harness {
  let harness: Harness = { reload: () => undefined };
  const value: DatabaseContextValue = {
    state: { status: 'ready', db: fakeDatabase },
    retry: () => undefined,
  };
  function Wrapper(): ReactNode {
    // Held so the probe keeps its hook identity across the test's own re-renders.
    const [context] = useState(value);
    return (
      <DatabaseContext.Provider value={context}>
        <Probe
          load={load}
          onReady={(next) => {
            harness = next;
          }}
        />
      </DatabaseContext.Provider>
    );
  }
  render(<Wrapper />);
  return {
    reload: () => {
      harness.reload();
    },
  };
}

describe('a superseded read', () => {
  it('never lands after the caller has said the rows changed', async () => {
    const reads = [deferred(), deferred()];
    let index = 0;
    const harness = renderProbe(() => {
      const read = reads[index];
      index += 1;
      return read?.promise ?? Promise.resolve('unexpected');
    });

    /*
     * The window the defect lives in, reproduced exactly. The older read has already come
     * back and is waiting its turn when the caller says the rows changed -- which is what
     * a save's success handler says. A guard tied to the effect's cleanup cannot have run
     * yet at this point, so it was never a guard; the generation is bumped inside
     * `reload` itself, before anything is scheduled.
     */
    await act(async () => {
      reads[0]?.resolve('rows before the write');
      harness.reload();
      await Promise.resolve();
    });

    expect(screen.getByTestId('value')).toHaveTextContent('loading');

    await act(async () => {
      reads[1]?.resolve('rows after the write');
      await Promise.resolve();
    });
    expect(screen.getByTestId('value')).toHaveTextContent('rows after the write');
  });

  it('never lands as a failure either', async () => {
    const first = deferred();
    const second = deferred();
    let index = 0;
    const harness = renderProbe(() => {
      index += 1;
      return index === 1 ? first.promise : second.promise;
    });

    await act(async () => {
      // A read that was already out of date failing tells the user nothing true about
      // the rows they are now looking at.
      first.reject(new Error('StaleReadError'));
      harness.reload();
      await Promise.resolve();
    });

    expect(screen.getByTestId('value')).toHaveTextContent('loading');

    await act(async () => {
      second.resolve('current rows');
      await Promise.resolve();
    });
    expect(screen.getByTestId('value')).toHaveTextContent('current rows');
  });

  it('still delivers a read nobody superseded', async () => {
    const only = deferred();
    renderProbe(() => only.promise);

    await act(async () => {
      only.resolve('the rows');
      await Promise.resolve();
    });
    expect(screen.getByTestId('value')).toHaveTextContent('the rows');
  });
});
