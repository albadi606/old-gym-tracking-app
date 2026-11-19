import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { type DraftOwnership, useDraftOwnership } from './useDraftOwnership.ts';

/**
 * The ownership protocol on its own.
 *
 * Both workout cards follow their stored record with this hook, so the rule is stated once
 * here rather than inferred twice from what a card happened to render. The card tests still
 * exist and still hold -- they prove the rule reaches a real form and a real database.
 * These prove the rule itself, including the ordering that broke the value-equality version
 * of it: **an edit that restores a value the record already held is still a later edit.**
 */

interface Record {
  updatedAt: string;
  value: string;
}

interface Draft {
  value: string;
}

interface Harness {
  ownership: DraftOwnership<Draft>;
  adoptions: number;
}

function harness(initial: Record): {
  result: { current: Harness };
  rerender: (props: { record: Record }) => void;
} {
  let adoptions = 0;
  const view = renderHook(
    ({ record }: { record: Record }) => {
      const ownership = useDraftOwnership<Record, Draft>({
        record,
        version: record.updatedAt,
        build: (next) => ({ value: next.value }),
        onAdopt: () => {
          adoptions += 1;
        },
      });
      return { ownership, adoptions };
    },
    { initialProps: { record: initial } },
  );
  return { result: view.result, rerender: view.rerender };
}

/**
 * The same hook, in a root whose record can be delivered as its own synchronous render.
 *
 * `renderHook`'s `rerender` batches with whatever else is queued, which is the one thing
 * that cannot reproduce a landing record overtaking an edit React has not rendered yet.
 * `flushSync` is what forces the two apart.
 */
function lanedHarness(initial: Record): {
  result: { current: Harness };
  root: { deliver: (record: Record) => void };
} {
  let adoptions = 0;
  const result = { current: undefined as unknown as Harness };
  let deliver: (record: Record) => void = () => undefined;

  function Probe(): null {
    const [record, setRecord] = useState(initial);
    deliver = setRecord;
    const ownership = useDraftOwnership<Record, Draft>({
      record,
      version: record.updatedAt,
      build: (next) => ({ value: next.value }),
      onAdopt: () => {
        adoptions += 1;
      },
    });
    result.current = { ownership, adoptions };
    return null;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  act(() => {
    reactRoot.render(<Probe />);
  });
  return {
    result,
    root: {
      deliver: (record) => {
        flushSync(() => {
          deliver(record);
        });
      },
    },
  };
}

const FIRST: Record = { updatedAt: '2026-09-07T05:00:00.000Z', value: '10' };
const SECOND: Record = { updatedAt: '2026-09-07T05:00:01.000Z', value: '12' };
const THIRD: Record = { updatedAt: '2026-09-07T05:00:02.000Z', value: '15' };

describe('a record arriving while the user holds no edit', () => {
  it('is adopted, so a reload or a refresh follows the database', () => {
    const { result, rerender } = harness(FIRST);
    expect(result.current.ownership.draft.value).toBe('10');

    rerender({ record: SECOND });

    expect(result.current.ownership.draft.value).toBe('12');
    expect(result.current.adoptions).toBe(1);
  });

  it('is adopted again once a save has acknowledged the draft the user made', () => {
    const { result, rerender } = harness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: '11' }));
    });
    const revision = result.current.ownership.currentRevision();
    act(() => {
      result.current.ownership.acknowledge(revision);
    });
    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(false);

    rerender({ record: THIRD });

    expect(result.current.ownership.draft.value).toBe('15');
  });
});

describe('a record arriving while the user holds an edit', () => {
  it('is not adopted, and the draft on screen is left alone', () => {
    const { result, rerender } = harness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: '14' }));
    });

    rerender({ record: SECOND });

    expect(result.current.ownership.draft.value).toBe('14');
    expect(result.current.adoptions).toBe(0);
  });

  /*
   * The defect the value-equality rule could not see. The user typed away from `10` and
   * typed it back, so the draft equalled the last adopted values -- and the card concluded
   * nobody had touched it and replaced the field with the write that was still in flight.
   */
  it('is not adopted when the edit restored the value the record already held', () => {
    const { result, rerender } = harness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: '12' }));
    });
    act(() => {
      result.current.ownership.editDraft(() => ({ value: '10' }));
    });

    // Byte-for-byte the value the record last held, and still the user's newer edit.
    expect(result.current.ownership.draft.value).toBe('10');
    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(true);

    rerender({ record: SECOND });

    expect(result.current.ownership.draft.value).toBe('10');
    expect(result.current.adoptions).toBe(0);
  });
});

describe('a record landing in its own synchronous render', () => {
  /*
   * The adoption decision reads the two revision counters directly, rather than a state
   * mirror of them.
   *
   * `editDraft` increments the revision synchronously and can only *schedule* any state
   * beside it, so a mirror is a derived fact that has to be kept correct by hand at every
   * call site, and a render taken between the two would read it stale. Reading the refs
   * removes the possibility rather than relying on React's batching to make it
   * unreachable.
   *
   * These two cases pin the seam through a landing record that forces its own synchronous
   * render instead of being batched with everything else -- the nearest a test can get to
   * a write arriving mid-keystroke. They are **not** evidence that the mirror lagged:
   * reverting to it leaves both of them passing, because React includes the pending edit
   * in the flush. The reproducible corruption came from the superseded read that
   * `shared/useDatabaseQuery.test.tsx` now pins, and that regression does fail by
   * reversion.
   */
  it('is refused while the user holds an edit, whatever order the renders arrive in', () => {
    const { result, root } = lanedHarness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: 'the user typed this' }));
      root.deliver(SECOND);
    });

    expect(result.current.ownership.draft.value).toBe('the user typed this');
    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(true);
    expect(result.current.adoptions).toBe(0);
  });

  it('is still adopted when there really is no edit, so a plain reload follows the database', () => {
    const { result, root } = lanedHarness(FIRST);

    act(() => {
      root.deliver(SECOND);
    });

    expect(result.current.ownership.draft.value).toBe('12');
    expect(result.current.adoptions).toBe(1);
  });
});

describe('what a completed write may acknowledge', () => {
  it('leaves a newer edit owned when an older revision is the one that landed', () => {
    const { result } = harness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: '12' }));
    });
    const older = result.current.ownership.currentRevision();
    act(() => {
      result.current.ownership.editDraft(() => ({ value: '10' }));
    });

    act(() => {
      result.current.ownership.acknowledge(older);
    });

    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(true);
  });

  it('hands ownership back when the revision it stored is the one still on screen', () => {
    const { result } = harness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: '12' }));
    });
    const revision = result.current.ownership.currentRevision();
    act(() => {
      result.current.ownership.acknowledge(revision);
    });

    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(false);
  });

  /*
   * A failed write acknowledges nothing, which is what keeps the entry on screen, keeps it
   * out of the way of an incoming record, and leaves Retry something to repeat.
   */
  it('keeps the draft owned when no write acknowledged it at all', () => {
    const { result, rerender } = harness(FIRST);

    act(() => {
      result.current.ownership.editDraft(() => ({ value: '14' }));
    });

    rerender({ record: SECOND });
    rerender({ record: THIRD });

    expect(result.current.ownership.draft.value).toBe('14');
    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(true);
  });
});

describe('rebuilding a draft', () => {
  it('is given the draft being replaced, so a presentation choice survives adoption', () => {
    const seen: (Draft | undefined)[] = [];
    const view = renderHook(
      ({ record }: { record: Record }) =>
        useDraftOwnership<Record, Draft>({
          record,
          version: record.updatedAt,
          build: (next, current) => {
            seen.push(current);
            return { value: `${next.value}/${current?.value ?? 'first'}` };
          },
        }),
      { initialProps: { record: FIRST } },
    );

    view.rerender({ record: SECOND });

    expect(seen[0]).toBeUndefined();
    expect(view.result.current.draft.value).toBe('12/10/first');
  });
});

describe('while an action that will close the card is outstanding', () => {
  it('refuses an edit, so nothing newer than the closing write can exist', () => {
    const { result } = harness(FIRST);

    act(() => {
      result.current.ownership.lockEdits('complete');
    });
    act(() => {
      result.current.ownership.editDraft(() => ({ value: '12' }));
    });

    expect(result.current.ownership.draft.value).toBe('10');
    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(false);
    expect(result.current.ownership.editsLocked).toBe(true);
  });

  it('stays locked until the holder that claimed it releases it', () => {
    const { result } = harness(FIRST);

    act(() => {
      result.current.ownership.lockEdits('skip');
      result.current.ownership.lockEdits('flush');
    });
    act(() => {
      result.current.ownership.releaseEdits('flush');
    });

    // Skip is still running; the flush it performed first must not hand the card back.
    expect(result.current.ownership.editsLocked).toBe(true);
    act(() => {
      result.current.ownership.editDraft(() => ({ value: '12' }));
    });
    expect(result.current.ownership.draft.value).toBe('10');

    act(() => {
      result.current.ownership.releaseEdits('skip');
    });
    expect(result.current.ownership.editsLocked).toBe(false);
  });

  it('accepts edits again once the action settles, so a failure is recoverable', () => {
    const { result } = harness(FIRST);

    act(() => {
      result.current.ownership.lockEdits('remove');
    });
    act(() => {
      result.current.ownership.releaseEdits('remove');
    });
    act(() => {
      result.current.ownership.editDraft(() => ({ value: '12' }));
    });

    expect(result.current.ownership.draft.value).toBe('12');
    expect(result.current.ownership.hasUnacknowledgedEdit()).toBe(true);
  });
});
