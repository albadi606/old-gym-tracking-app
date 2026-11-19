import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import type { CardioSegment } from '../../domain/schemas.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { getTemplateBySeedKey, startSessionFromTemplate } from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * An action that cannot be undone must not run ahead of the draft it depends on.
 *
 * Two defects live here, and they are the same shape. Finishing unmounted a card holding
 * a typed value and closed the session without it. Removing or skipping a segment ran
 * after a *failed* save, so the repository judged a row that did not yet contain the
 * observation the user could see, and its guard let the destruction through on an empty
 * record. In both cases the queue guaranteed order and nobody had asked for success.
 *
 * A workout that stays open can always be finished again; a number that has been thrown
 * away cannot be recovered.
 */

const START = '2026-09-04T05:00:00.000Z';
const copy = en.pages.workout;
const NOTE = 'Checked the treadmill display';

function routes(): React.ReactNode {
  return (
    <Routes>
      <Route
        path={ROUTE_PATHS.workout}
        element={
          <WorkoutPage clock={createFixedClock(START)} ids={createSequentialIdProvider(9000)} />
        }
      />
    </Routes>
  );
}

async function startTemplateSession(db: GymTrackerDatabase): Promise<void> {
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  await startSessionFromTemplate(db, template?.id ?? '', {
    clock: createFixedClock(START),
    ids: createSequentialIdProvider(5000),
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
  });
}

async function renderRunningWorkout(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({
    route: ROUTE_PATHS.workout,
    children: routes(),
    seed: startTemplateSession,
  });
  await screen.findByRole('heading', { name: 'Treadmill' });
  return view;
}

async function storedSegment(
  db: GymTrackerDatabase,
  position: number,
): Promise<CardioSegment | undefined> {
  const all = await db.cardioSegments.toArray();
  return all.sort((a, b) => a.position - b.position)[position];
}

function segmentCard(position: number): HTMLElement {
  const heading = screen.getByRole('heading', {
    name: new RegExp(`^Segment ${String(position)}:`),
  });
  const card = heading.closest('li');
  if (!card) {
    throw new Error(`No card found for segment ${String(position)}`);
  }
  return card;
}

async function confirmFinish(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: copy.finish }));
  await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));
}

describe('finishing flushes every draft first', () => {
  it('saves a value that was never blurred, then completes the session', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    // Typed and left in the field: no blur, no Save tap. The old code lost this.
    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    await confirmFinish(user);

    await screen.findByText(copy.finishedTitle);
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);

    await destroyTestDatabase(view.db);
  });

  it('keeps the workout open and the value visible when that flush fails', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    // Storage refuses every write, including the one Finish makes to flush the draft.
    const put = vi
      .spyOn(view.db.cardioSegments, 'put')
      .mockRejectedValue(new Error('QuotaExceededError'));

    await confirmFinish(user);

    expect(await screen.findByText(copy.draftBlockedTitle)).toBeInTheDocument();
    // Nothing was closed, so the session can still be finished once the value is stored.
    const session = await view.db.workoutSessions.toCollection().first();
    expect(session?.status).toBe('in_progress');
    expect(session?.completedAt).toBeUndefined();
    // And the value is still on screen rather than gone with the unmounted card.
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');

    put.mockRestore();
    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);

    await destroyTestDatabase(view.db);
  });

  it('refuses to finish while a segment holds a value that cannot be saved', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), 'abc');
    await confirmFinish(user);

    const blocked = await screen.findByText(copy.draftBlockedTitle);
    // The message names the segment that needs attention, not "a segment somewhere".
    const message = blocked.closest('section');
    expect(within(message as HTMLElement).getByText(/Segment 1/)).toBeInTheDocument();
    const session = await view.db.workoutSessions.toCollection().first();
    expect(session?.status).toBe('in_progress');

    // Clearing the unusable value is a valid resolution, and then Finish works.
    await user.clear(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel));
    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);

    await destroyTestDatabase(view.db);
  });

  it('waits for a save that is already in flight rather than racing it', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = view.db.cardioSegments.put.bind(view.db.cardioSegments);
    const put = vi.spyOn(view.db.cardioSegments, 'put');
    // Dexie hands back its own promise type, so the held stand-in is cast to match it.
    put.mockImplementationOnce(((record: CardioSegment) =>
      held.then(() => original(record))) as unknown as typeof original);

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    // Blur starts the save; the tap arrives while it is still open.
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));
    await confirmFinish(user);

    // Nothing terminal may happen until the held write settles.
    expect(await view.db.workoutSessions.toCollection().first()).toMatchObject({
      status: 'in_progress',
    });
    release?.();

    await screen.findByText(copy.finishedTitle);
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);
    put.mockRestore();

    await destroyTestDatabase(view.db);
  });

  it('applies the same barrier to cancelling, which also keeps what was recorded', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '2.4');
    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));

    await screen.findByText(copy.cancelledTitle);
    // Cancelling keeps recorded work, so the last thing typed is kept too.
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(2400);

    await destroyTestDatabase(view.db);
  });
});

describe('a cleared field is cleared in the database', () => {
  it('empties the stored value and stays empty after the page is rebuilt', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const field = (): HTMLElement =>
      within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel);

    await user.type(field(), '3.05');
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    await user.clear(field());
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      // Absent, not zero. The old patch omitted the key, so 3050 survived the clear.
      expect(stored?.actualDistanceMeters).toBeUndefined();
    });
    expect(field()).toHaveValue('');

    await destroyTestDatabase(view.db);
  });
});

describe('a destructive action waits for the draft to be durable', () => {
  it('does not remove a segment whose typed value failed to save', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    const put = vi
      .spyOn(view.db.cardioSegments, 'put')
      .mockRejectedValue(new Error('QuotaExceededError'));

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.removeSegment }));
    await user.click(await screen.findByRole('button', { name: copy.removeDialogConfirm }));

    expect(await screen.findByText(copy.unsavedBlockedBody)).toBeInTheDocument();
    // The row survived: the repository was never asked about a record missing the value.
    await expect(view.db.cardioSegments.count()).resolves.toBe(2);
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');

    // Once the write succeeds, the repository judges what is really stored -- and refuses,
    // because by then the segment genuinely holds a recorded distance.
    put.mockRestore();
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.removeSegment }));
    await user.click(await screen.findByRole('button', { name: copy.removeDialogConfirm }));

    expect(await screen.findByText(copy.recordedWorkBlockedBody)).toBeInTheDocument();
    await expect(view.db.cardioSegments.count()).resolves.toBe(2);
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);

    await destroyTestDatabase(view.db);
  });

  it('does not hide a typed observation behind "skipped" when its save failed', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    // Speed alone: the exact case the broad recorded-work predicate exists to protect.
    await user.type(within(segmentCard(1)).getByLabelText(copy.actualSpeedLabel), '8.6');
    const put = vi
      .spyOn(view.db.cardioSegments, 'put')
      .mockRejectedValue(new Error('QuotaExceededError'));

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.skipSegment }));

    expect(await screen.findByText(copy.unsavedBlockedBody)).toBeInTheDocument();
    const afterFailure = await storedSegment(view.db, 0);
    expect(afterFailure?.status).toBe('planned');
    expect(afterFailure?.actualSpeedKph).toBeUndefined();
    // Still editable, still showing what was typed, so nothing is stranded behind a
    // disabled card the way a premature "skipped" would have left it.
    expect(within(segmentCard(1)).getByLabelText(copy.actualSpeedLabel)).toHaveValue('8.6');

    put.mockRestore();
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.skipSegment }));

    expect(await screen.findByText(copy.recordedWorkBlockedBody)).toBeInTheDocument();
    const afterRetry = await storedSegment(view.db, 0);
    expect(afterRetry?.status).toBe('planned');
    expect(afterRetry?.actualSpeedKph).toBe(8.6);

    await destroyTestDatabase(view.db);
  });

  it('removes the segment once the draft is deliberately cleared', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    await user.clear(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel));
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.removeSegment }));
    await user.click(await screen.findByRole('button', { name: copy.removeDialogConfirm }));

    // The clear is flushed first, so the repository sees an empty row and agrees.
    await waitFor(async () => {
      await expect(view.db.cardioSegments.count()).resolves.toBe(1);
    });

    await destroyTestDatabase(view.db);
  });
});

describe('a finished workout never calls a stored observation nonexistent', () => {
  it('shows a saved value from a segment that was never marked done', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    // Marked nothing done, then finished. The database holds 3.05 km.
    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);

    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    // The lie this test exists for: "Nothing was recorded" beside a stored 3.05 km.
    expect(within(summary).queryByText(copy.noActualTitle)).not.toBeInTheDocument();
    expect(within(summary).getByText(copy.noneMarkedDoneTitle)).toBeInTheDocument();
    expect(within(summary).getByText(copy.savedNotFinishedHeading)).toBeInTheDocument();
    expect(within(summary).getAllByText('3.05 km').length).toBeGreaterThan(0);

    const stored = await storedSegment(view.db, 0);
    expect(stored?.status).toBe('planned');
    expect(stored?.actualDistanceMeters).toBe(3050);

    await destroyTestDatabase(view.db);
  });

  it('still says nothing was recorded when nothing was', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);

    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    expect(within(summary).getByText(copy.noActualTitle)).toBeInTheDocument();
    expect(within(summary).queryByText(copy.savedNotFinishedHeading)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('keeps a cancelled session honest about what it kept', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(
      within(segmentCard(1)).getByLabelText(copy.segmentNotesLabel),
      'Checked the console',
    );
    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));
    await screen.findByText(copy.cancelledTitle);

    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    expect(within(summary).queryByText(copy.noActualTitle)).not.toBeInTheDocument();
    expect(within(summary).getByText(copy.savedNotFinishedHeading)).toBeInTheDocument();
    // The heading is not the point: the note itself has to be readable. Asserting only
    // the heading and the database is exactly how the missing note went unnoticed.
    expect(within(summary).getByText('Checked the console')).toBeInTheDocument();
    expect((await storedSegment(view.db, 0))?.notes).toBe('Checked the console');

    await destroyTestDatabase(view.db);
  });
});

describe('the summary shows every observation it was saved, not just the measurements', () => {
  /*
   * A segment counts as holding recorded work if any of eight fields has a value, but the
   * summary could render only four of them. So a workout could close with a heart rate, an
   * effort rating, and the note explaining why the run stopped all sitting in IndexedDB
   * while the screen listed the segment under "saved, but never marked done" and showed
   * nothing at all underneath. There is no history screen yet, so that summary is the only
   * chance to read them.
   */
  async function recordSecondaryObservations(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    const card = within(segmentCard(1));
    await user.type(card.getByLabelText(copy.averageHeartRateLabel), '142');
    await user.type(card.getByLabelText(copy.maxHeartRateLabel), '167');
    await user.type(card.getByLabelText(copy.rpeLabel), '7.5');
    await user.type(card.getByLabelText(copy.segmentNotesLabel), NOTE);
    await user.click(card.getByRole('button', { name: copy.saveSegment }));
  }

  /** The one summary row for a segment, so a value cannot be read off its neighbour. */
  function summaryRow(position: number): HTMLElement {
    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    const heading = within(summary).getByRole('heading', {
      name: new RegExp(`^Segment ${String(position)}:`),
    });
    const row = heading.closest('li');
    if (!row) {
      throw new Error(`No summary row for segment ${String(position)}`);
    }
    return row;
  }

  function expectEverySecondaryValueVisible(): void {
    const row = within(summaryRow(1));
    // Beside the status, so nothing here can be misread as finished work.
    expect(row.getByRole('heading', { level: 4 }).textContent).toContain(en.segmentStatus.planned);
    expect(row.getByText('142 bpm')).toBeInTheDocument();
    expect(row.getByText('167 bpm')).toBeInTheDocument();
    expect(row.getByText('7.5 out of 10')).toBeInTheDocument();
    expect(row.getByText(NOTE)).toBeInTheDocument();
  }

  async function expectEverySecondaryValueStored(db: GymTrackerDatabase): Promise<void> {
    const stored = await storedSegment(db, 0);
    expect(stored?.status).toBe('planned');
    expect(stored?.averageHeartRateBpm).toBe(142);
    expect(stored?.maxHeartRateBpm).toBe(167);
    expect(stored?.rpe).toBe(7.5);
    expect(stored?.notes).toBe(NOTE);
  }

  it('shows a heart rate, an effort rating, and a note after Finish', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await recordSecondaryObservations(user);
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.notes).toBe(NOTE);
    });

    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);

    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    expect(within(summary).queryByText(copy.noActualTitle)).not.toBeInTheDocument();
    expect(within(summary).getByText(copy.savedNotFinishedHeading)).toBeInTheDocument();
    expectEverySecondaryValueVisible();

    // Shown, and still not counted: nobody said this segment was done.
    expect(within(summary).getByText(copy.noneMarkedDoneTitle)).toBeInTheDocument();
    expect(within(summary).queryByText(copy.averageSpeed)).not.toBeInTheDocument();
    await expectEverySecondaryValueStored(view.db);

    await destroyTestDatabase(view.db);
  });

  it('shows the same four values after Cancel', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await recordSecondaryObservations(user);
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.rpe).toBe(7.5);
    });

    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));
    await screen.findByText(copy.cancelledTitle);

    expectEverySecondaryValueVisible();
    await expectEverySecondaryValueStored(view.db);

    await destroyTestDatabase(view.db);
  });

  it('shows the same values on a segment that was marked done', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await recordSecondaryObservations(user);
    // A distance so completion has measurable work to stand on, then marked done.
    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.completeSegment }));
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.status).toBe('completed');
    });

    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);

    const row = within(summaryRow(1));
    expect(row.getByText('142 bpm')).toBeInTheDocument();
    expect(row.getByText('167 bpm')).toBeInTheDocument();
    expect(row.getByText('7.5 out of 10')).toBeInTheDocument();
    expect(row.getByText(NOTE)).toBeInTheDocument();
    // The completed row belongs to the comparison, not to the saved-but-unfinished list.
    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    expect(within(summary).queryByText(copy.savedNotFinishedHeading)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('lists a segment once, not twice, when it is saved but unfinished', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await recordSecondaryObservations(user);
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.notes).toBe(NOTE);
    });

    await confirmFinish(user);
    await screen.findByText(copy.finishedTitle);

    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    // One row for segment 1 and one for segment 2 -- every segment, each exactly once.
    expect(within(summary).getAllByRole('heading', { name: /^Segment 1:/ })).toHaveLength(1);
    expect(within(summary).getAllByRole('heading', { name: /^Segment 2:/ })).toHaveLength(1);
    expect(within(summary).getAllByText(NOTE)).toHaveLength(1);

    await destroyTestDatabase(view.db);
  });
});
