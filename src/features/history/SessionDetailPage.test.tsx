import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { archiveMachine } from '../../db/catalog-repository.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { createFixedClock } from '../../domain/clock.ts';
import { en } from '../../i18n/en.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { startBlankSession } from '../../db/workout-repository.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import { seedRecordedWorkout } from '../../test/history.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * One recorded workout on screen, and the three things that may be done to it.
 *
 * Every test reaches the page the way a person does -- through the history list -- so the
 * link, the route, and the read are all exercised rather than assumed.
 */

const copy = en.pages.history.detail;
const CLOCK = createFixedClock('2026-09-08T05:00:00.000Z');

async function openWorkout(
  name: string,
  seed?: (db: GymTrackerDatabase) => Promise<void>,
): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const user = userEvent.setup();
  const view = await renderWithDatabase({
    route: '/history',
    seed: async (db) => {
      await seedRecordedWorkout(db, { name, segmentNotes: 'Checked the console' });
      if (seed) {
        await seed(db);
      }
    },
  });

  await user.click(await screen.findByRole('link', { name: `Open ${name}` }));
  await screen.findByRole('heading', { level: 1, name });
  return view;
}

describe('what a recorded workout says', () => {
  it('shows its status, when it ran, and how long it was open', async () => {
    const view = await openWorkout('Tuesday legs');

    expect(screen.getByText(en.sessionStatus.completed)).toBeInTheDocument();
    expect(screen.getByText(copy.durationLabel)).toBeInTheDocument();
    // The zone it was recorded in is stated, not silently reinterpreted.
    expect(screen.getByText('Asia/Tbilisi')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('shows the recorded cardio values beside the planned ones, and the note', async () => {
    const view = await openWorkout('Tuesday legs');

    // Scoped to the first segment: the seeded routine has two, and both carry the
    // same field labels.
    const segment = within(screen.getByLabelText('Segment 1'));
    expect(
      segment.getByText(`${copy.recordedHeading} · ${copy.distanceLabel}`),
    ).toBeInTheDocument();
    expect(segment.getByText(`${copy.plannedHeading} · ${copy.distanceLabel}`)).toBeInTheDocument();
    // The planned and the recorded distance happen to match here, so both rows carry it.
    expect(segment.getAllByText('2.4 km').length).toBe(2);
    // A note is often the only record of why a segment stopped.
    expect(segment.getByText('Checked the console')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('shows a set with what its number means, never the number alone', async () => {
    const view = await openWorkout('Tuesday legs');

    const set = within(screen.getByLabelText('Set 1'));
    expect(set.getByText('40 kg')).toBeInTheDocument();
    expect(set.getByText(en.loadBasis.stack_display)).toBeInTheDocument();
    expect(set.getByText(en.bodySide.both)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('says plainly when the equipment has been archived since', async () => {
    const view = await openWorkout('Tuesday legs', async (db) => {
      const machine = await db.machines.where('seedKey').equals('seated-leg-press-01').first();
      if (machine) {
        await archiveMachine(db, machine.id, CLOCK);
      }
    });

    // The seeded routine references the archived machine from more than one activity.
    expect((await screen.findAllByText(copy.archivedLinkTitle)).length).toBeGreaterThan(0);
    // What was recorded is still readable.
    expect(screen.getByText('40 kg')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('correcting a workout', () => {
  it('is read-only until the user asks to correct it', async () => {
    const view = await openWorkout('Tuesday legs');

    expect(screen.queryByLabelText(copy.repsLabel)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.correct })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('saves a corrected cardio value and a corrected set in one action', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));

    const segment = within(screen.getByLabelText('Segment 1'));
    const distance = segment.getByLabelText(`${copy.distanceLabel} (km)`);
    await user.clear(distance);
    await user.type(distance, '3.4');

    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '12');

    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    expect(await screen.findByText(copy.correctionSaved)).toBeInTheDocument();
    /*
     * Read back from the database, not from what the form hoped it had written. The
     * corrected distance appears twice on purpose: on the segment, and in the session's
     * recorded totals.
     */
    expect((await screen.findAllByText('3.4 km')).length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText('Set 1')).getByText('12')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('really removes a field the user emptied', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    expect(screen.getByText('Checked the console')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.correct }));
    // Each segment and each set owns a note field, so the one being cleared is named.
    await user.clear(within(screen.getByLabelText('Segment 1')).getByLabelText(copy.noteLabel));
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    await screen.findByText(copy.correctionSaved);
    /*
     * The banner appears when the write is durable; the screen updates when the re-read
     * lands. Waiting for the value to leave the page is an assertion that the reload
     * really arrived, rather than a pause hoping it did.
     */
    await waitFor(() => {
      expect(screen.queryByText('Checked the console')).not.toBeInTheDocument();
    });

    await destroyTestDatabase(view.db);
  });

  it('keeps the draft and offers a retry when the write is refused', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));

    /*
     * A completed set must still record measurable work, so clearing both the reps and
     * the time is refused inside the transaction. That is a real refusal from the
     * repository rather than a stubbed rejection, and what matters here is what the
     * screen does with it.
     */
    await user.clear(screen.getByLabelText(copy.repsLabel));
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    expect(await screen.findByText(copy.correctionFailedTitle)).toBeInTheDocument();
    // Still in correction mode, with the emptied field exactly as the user left it.
    expect(screen.getByLabelText(copy.repsLabel)).toHaveValue('');
    expect(screen.getByRole('button', { name: copy.retryCorrection })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('discards a correction without writing anything', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '99');
    await user.click(screen.getByRole('button', { name: copy.discardCorrection }));

    expect(screen.queryByLabelText(copy.repsLabel)).not.toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

/**
 * Holds the correction's read-write transaction until it is released.
 *
 * The same shape the workout cards' tests use, and for the same reason: "the write is
 * still in flight" has to be a fact the test controls rather than a coincidence of
 * scheduling. Reads pass straight through, so the page keeps rendering.
 */
function holdNextWrite(db: GymTrackerDatabase): () => void {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = (): void => {
      resolve();
    };
  });
  const real = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  let held = false;
  const spy = vi.spyOn(db, 'transaction') as unknown as {
    mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
  };
  spy.mockImplementation((...args: unknown[]) => {
    if (args[0] === 'rw' && !held) {
      held = true;
      return gate.then(() => real(...args));
    }
    return real(...args);
  });
  return () => {
    release();
  };
}

/**
 * Types into a field the way something other than a person could.
 *
 * The disabled attribute is what the user sees; it is not the guard. This dispatches the
 * change regardless, so what is being asserted is the page's own synchronous refusal.
 */
function forceEdit(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

/** Lets the released transaction and the re-read that follows it settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('while an accepted correction is being saved', () => {
  /*
   * Save validates and captures the correction before it awaits the transaction. Every
   * edit path stayed live across that await, so a value typed while the write was in
   * flight was kept on screen by the form, left out of the write by the capture, and then
   * destroyed when success closed the editor -- the page said "Corrections saved" over a
   * number that had reached neither the database nor the next render. The submit guard
   * never covered this: it stops a second Save, not an edit to the draft the first one
   * took.
   *
   * So Save takes the draft synchronously, before its first await, and hands it back only
   * when the transaction settles.
   */
  it('refuses a later edit to the session facts and stores what it accepted', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const name = screen.getByLabelText(copy.nameLabel);
    await user.clear(name);
    await user.type(name, 'Tuesday legs, corrected');

    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    expect(screen.getByLabelText(copy.nameLabel)).toBeDisabled();
    forceEdit(screen.getByLabelText(copy.nameLabel), 'typed while saving');
    expect(screen.getByLabelText(copy.nameLabel)).toHaveValue('Tuesday legs, corrected');

    release();
    await screen.findByText(copy.correctionSaved);
    await waitFor(async () => {
      const stored = await view.db.workoutSessions.toArray();
      expect(stored[0]?.name).toBe('Tuesday legs, corrected');
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tuesday legs, corrected' }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('refuses a later edit to a cardio field', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const segment = within(screen.getByLabelText('Segment 1'));
    const distance = segment.getByLabelText(`${copy.distanceLabel} (km)`);
    await user.clear(distance);
    await user.type(distance, '3.4');

    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    const held = within(screen.getByLabelText('Segment 1')).getByLabelText(
      `${copy.distanceLabel} (km)`,
    );
    expect(held).toBeDisabled();
    forceEdit(held, '9.9');
    expect(held).toHaveValue('3.4');

    release();
    await screen.findByText(copy.correctionSaved);
    await waitFor(async () => {
      const segments = await view.db.cardioSegments.toArray();
      const first = segments.sort((a, b) => a.position - b.position)[0];
      expect(first?.actualDistanceMeters).toBe(3400);
    });

    await destroyTestDatabase(view.db);
  });

  it('refuses a later edit to the strength load and reps together', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '12');
    const load = screen.getByLabelText(copy.loadLabel);
    await user.clear(load);
    await user.type(load, '45');

    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    expect(screen.getByLabelText(copy.repsLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.loadLabel)).toBeDisabled();
    forceEdit(screen.getByLabelText(copy.repsLabel), '99');
    forceEdit(screen.getByLabelText(copy.loadLabel), '99');
    expect(screen.getByLabelText(copy.repsLabel)).toHaveValue('12');
    expect(screen.getByLabelText(copy.loadLabel)).toHaveValue('45');

    release();
    await screen.findByText(copy.correctionSaved);
    await waitFor(async () => {
      const sets = await view.db.strengthSets.toArray();
      expect(sets[0]?.reps).toBe(12);
      expect(sets[0]?.loadValue).toBe(45);
    });

    await destroyTestDatabase(view.db);
  });

  it('refuses Discard, so it cannot erase an editor whose write is about to succeed', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '12');

    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));

    const discard = screen.getByRole('button', { name: copy.discardCorrection });
    expect(discard).toBeDisabled();
    fireEvent.click(discard);
    // Still in correction mode, still holding the accepted draft.
    expect(screen.getByLabelText(copy.repsLabel)).toHaveValue('12');

    release();
    await screen.findByText(copy.correctionSaved);
    await waitFor(async () => {
      const sets = await view.db.strengthSets.toArray();
      expect(sets[0]?.reps).toBe(12);
    });

    await destroyTestDatabase(view.db);
  });

  it('hands the exact draft back when the write is refused, and the retry stores it', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '12');

    // A real refusal from the repository: the transaction is made to fail once.
    const put = vi
      .spyOn(view.db.strengthSets, 'put')
      .mockRejectedValueOnce(new Error('QuotaExceededError'));
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));
    expect(await screen.findByText(copy.correctionFailedTitle)).toBeInTheDocument();

    // Released: editable again, with exactly what was typed, and the retry writes it.
    const editable = screen.getByLabelText(copy.repsLabel);
    expect(editable).not.toBeDisabled();
    expect(editable).toHaveValue('12');
    expect(screen.getByRole('button', { name: copy.discardCorrection })).not.toBeDisabled();

    put.mockRestore();
    await user.click(screen.getByRole('button', { name: copy.retryCorrection }));
    await screen.findByText(copy.correctionSaved);
    await waitFor(async () => {
      const sets = await view.db.strengthSets.toArray();
      expect(sets[0]?.reps).toBe(12);
    });

    await destroyTestDatabase(view.db);
  });

  it('treats a rapid second Save as one correction, not two', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '12');

    const spy = vi.spyOn(view.db.strengthSets, 'put');
    const release = holdNextWrite(view.db);
    const save = screen.getByRole('button', { name: copy.saveCorrection });
    // Both presses land before React has re-rendered anything, which is what a thumb
    // on a phone produces and what the disabled attribute alone would not stop.
    fireEvent.click(save);
    fireEvent.click(save);

    release();
    await screen.findByText(copy.correctionSaved);
    await settle();
    // One correction, one write: the second press asked for what the first was already
    // doing, and the draft it would have written was the same one.
    expect(spy).toHaveBeenCalledTimes(1);

    await waitFor(async () => {
      const sets = await view.db.strengthSets.toArray();
      expect(sets[0]?.reps).toBe(12);
    });

    await destroyTestDatabase(view.db);
  });

  it('stores a correction that survives closing and reopening the page', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.correct }));
    const reps = screen.getByLabelText(copy.repsLabel);
    await user.clear(reps);
    await user.type(reps, '12');

    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.saveCorrection }));
    forceEdit(screen.getByLabelText(copy.repsLabel), '99');
    release();
    await screen.findByText(copy.correctionSaved);

    await waitFor(async () => {
      const sets = await view.db.strengthSets.toArray();
      expect(sets[0]?.reps).toBe(12);
    });

    // Read back through a fresh connection, so nothing in memory can be the answer.
    view.unmount();
    view.db.close();
    await view.db.open();
    const stored = await view.db.strengthSets.toArray();
    expect(stored[0]?.reps).toBe(12);

    await destroyTestDatabase(view.db);
  });
});

describe('a History address for the workout that is still open', () => {
  /*
   * The list already excludes an in-progress workout, and the repository refuses to
   * correct, delete, or repeat one. A page that renders those buttons anyway advertises
   * operations that cannot succeed, and treating an unfinished workout as recorded
   * history would offer a route around the draft ownership the workout screen depends on.
   */
  it('says the workout is still open and offers only to resume it', async () => {
    /*
     * A pasted address, so the id is fixed in advance rather than discovered: the route
     * is chosen before the page renders, exactly as it is when the link is opened.
     */
    const sessionId = '00000000-0000-4000-8000-000000000900';
    const view = await renderWithDatabase({
      route: `/history/${sessionId}`,
      seed: async (db) => {
        await startBlankSession(db, {
          name: 'Still going',
          timeZone: 'Asia/Tbilisi',
          utcOffsetMinutes: 240,
          clock: CLOCK,
          ids: createSequentialIdProvider(900),
        });
      },
    });

    expect(await screen.findByText(copy.inProgressTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.resumeWorkout })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.correct })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.deleteAction })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.repeat })).not.toBeInTheDocument();
    // Nor is it presented as a recorded workout at all.
    expect(screen.queryByText(copy.statusLabel)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('is kept out of the history list itself', async () => {
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        await startBlankSession(db, {
          name: 'Still going',
          timeZone: 'Asia/Tbilisi',
          utcOffsetMinutes: 240,
          clock: CLOCK,
          ids: createSequentialIdProvider(900),
        });
      },
    });

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Still going')).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('the filter panel', () => {
  it('is a search landmark, in markup this runtime recognises', async () => {
    const view = await renderWithDatabase({ route: '/history' });
    expect(await screen.findByRole('search')).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('deleting and restoring', () => {
  it('confirms by name, then offers an immediate undo', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.deleteAction }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Tuesday legs/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: copy.deleteConfirm }));

    expect(await screen.findByText(copy.deletedTitleShort)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.undoDelete }));

    expect(await screen.findByRole('button', { name: copy.correct })).toBeInTheDocument();
    expect(screen.queryByText(copy.deletedTitle)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('keeps the workout when the confirmation is declined', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.deleteAction }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: copy.deleteCancel }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.correct })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('will not offer to correct a workout that is in the trash', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs');

    await user.click(screen.getByRole('button', { name: copy.deleteAction }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: copy.deleteConfirm }));

    await screen.findByText(copy.deletedTitle);
    expect(screen.queryByRole('button', { name: copy.correct })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.deleteAction })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('repeating a workout', () => {
  it('refuses while another workout is open, and points at it', async () => {
    const user = userEvent.setup();
    const view = await openWorkout('Tuesday legs', async (db) => {
      await seedRecordedWorkout(db, {
        idBase: 5000,
        name: 'Still going',
        startedAt: '2026-09-07T05:00:00.000Z',
        ending: 'open',
      });
    });

    await user.click(screen.getByRole('button', { name: copy.repeat }));

    expect(await screen.findByText(copy.repeatBlockedTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.goToWorkout })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
