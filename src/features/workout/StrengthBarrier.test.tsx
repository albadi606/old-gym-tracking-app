import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import type { StrengthSet } from '../../domain/schemas.ts';
import { RECORDED_SET_FIELDS } from '../../domain/workout/strength-work.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { addStrengthSet } from '../../db/strength-repository.ts';
import { getTemplateBySeedKey, startSessionFromTemplate } from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * Closing a workout must not close it over a strength set.
 *
 * Finishing unmounts every card, so anything a card is still holding is gone with it. The
 * save barrier for treadmill segments has to cover strength sets too, or the
 * defect it was built for simply moves to the other kind of card.
 *
 * The other half is the summary. A set holding something saved that was never marked done
 * is correctly kept out of every total, and it is just as deliberately not described as
 * nonexistent -- so every field that makes it qualify is carried and shown.
 */

const START = '2026-09-05T05:00:00.000Z';
const copy = en.pages.workout;
const NOTE = 'Adjusted the seat after the third rep';

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

async function seedRunningWorkout(db: GymTrackerDatabase): Promise<void> {
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  const detail = await startSessionFromTemplate(db, template?.id ?? '', {
    clock: createFixedClock(START),
    ids: createSequentialIdProvider(5000),
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
  });
  const activity = detail.activities.find(
    (candidate) => candidate.displayName === 'Seated leg press',
  );
  await addStrengthSet(db, activity?.id ?? '', { clock: createFixedClock(START) });
}

async function renderRunningWorkout(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({
    route: ROUTE_PATHS.workout,
    children: routes(),
    seed: seedRunningWorkout,
  });
  await screen.findByRole('heading', { name: 'Set 1' });
  return view;
}

function setCard(position: number): HTMLElement {
  const heading = screen.getByRole('heading', {
    name: formatMessage(copy.setHeading, { position }),
  });
  const card = heading.closest('li');
  if (!card) {
    throw new Error(`No card found for set ${String(position)}`);
  }
  return card;
}

async function storedSet(db: GymTrackerDatabase): Promise<StrengthSet | undefined> {
  return (await db.strengthSets.toArray())[0];
}

/** Everything a user can put into a set, typed into the rendered form. */
async function recordEverything(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const card = setCard(1);
  await user.type(within(card).getByLabelText(copy.repsLabel), '10');
  await user.type(within(card).getByLabelText(copy.setDurationLabel), '00:45');
  await user.type(within(card).getByLabelText(copy.loadLabel), '60');
  await user.type(within(card).getByLabelText(copy.setRpeLabel), '7.5');
  await user.type(within(card).getByLabelText(copy.setRirLabel), '2');
  await user.type(within(card).getByLabelText(copy.setNotesLabel), NOTE);
}

function expectEveryValueVisible(row: HTMLElement): void {
  expect(within(row).getByText('10')).toBeInTheDocument();
  expect(within(row).getByText('00:45')).toBeInTheDocument();
  expect(within(row).getByText('60 kg')).toBeInTheDocument();
  expect(within(row).getByText('7.5 out of 10')).toBeInTheDocument();
  expect(within(row).getByText('2')).toBeInTheDocument();
  expect(within(row).getByText(NOTE)).toBeInTheDocument();
}

async function expectEveryValueStored(db: GymTrackerDatabase): Promise<void> {
  const stored = await storedSet(db);
  expect(stored).toMatchObject({
    reps: 10,
    durationSeconds: 45,
    loadValue: 60,
    loadUnit: 'kg',
    rpe: 7.5,
    rir: 2,
    notes: NOTE,
  });
  // Saved, and still never claimed as finished.
  expect(stored?.status).toBe('planned');
  expect(stored?.completedAt).toBeUndefined();
}

describe('finishing and cancelling flush a strength draft first', () => {
  it.each([
    ['finish', copy.finish, copy.finishDialogConfirm],
    ['cancel', copy.cancel, copy.cancelDialogConfirm],
  ] as const)(
    'saves what the card was holding before %s closes the session',
    async (_label, open, confirm) => {
      const user = userEvent.setup();
      const view = await renderRunningWorkout();

      // Typed and never blurred: without the barrier this is gone the moment it closes.
      await user.type(within(setCard(1)).getByLabelText(copy.repsLabel), '10');
      await user.click(screen.getByRole('button', { name: open }));
      await user.click(await screen.findByRole('button', { name: confirm }));

      await screen.findByText(open === copy.finish ? copy.finishedTitle : copy.cancelledTitle);
      await waitFor(async () => {
        expect((await storedSet(view.db))?.reps).toBe(10);
      });
      expect((await storedSet(view.db))?.status).toBe('planned');

      await destroyTestDatabase(view.db);
    },
  );

  /*
   * A workout that stays open can be finished again; a number thrown away cannot be
   * recovered. So a draft that cannot be made durable holds the session open and names
   * the card that needs attention.
   */
  it('refuses to close when a strength draft cannot be saved, and names the set', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    const put = vi.spyOn(view.db.strengthSets, 'put').mockRejectedValue(new Error('quota'));
    await user.type(within(setCard(1)).getByLabelText(copy.repsLabel), '10');
    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    expect(await screen.findByText(copy.draftBlockedTitle)).toBeInTheDocument();
    expect(
      screen.getByText(
        formatMessage(copy.draftBlockedFailedBody, { segment: 'Seated leg press, set 1' }),
      ),
    ).toBeInTheDocument();
    // The session is still open and the typed value is still on screen.
    expect(screen.getByRole('button', { name: copy.finish })).toBeInTheDocument();
    expect(within(setCard(1)).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect((await view.db.workoutSessions.toArray())[0]?.status).toBe('in_progress');
    put.mockRestore();

    await destroyTestDatabase(view.db);
  });

  it('refuses to close when a strength draft holds a value that cannot be saved', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.type(within(setCard(1)).getByLabelText(copy.repsLabel), '8.5');
    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));

    expect(
      await screen.findByText(
        formatMessage(copy.draftBlockedInvalidBody, { segment: 'Seated leg press, set 1' }),
      ),
    ).toBeInTheDocument();
    expect((await view.db.workoutSessions.toArray())[0]?.status).toBe('in_progress');

    await destroyTestDatabase(view.db);
  });
});

describe('the summary shows the strength work that was recorded', () => {
  it.each([
    ['finish', copy.finish, copy.finishDialogConfirm],
    ['cancel', copy.cancel, copy.cancelDialogConfirm],
  ] as const)(
    'shows every saved value of an unfinished set after %s',
    async (_label, open, confirm) => {
      const user = userEvent.setup();
      const view = await renderRunningWorkout();

      await recordEverything(user);
      await user.click(within(setCard(1)).getByRole('button', { name: copy.saveSet }));
      await waitFor(async () => {
        expect((await storedSet(view.db))?.notes).toBe(NOTE);
      });

      await user.click(screen.getByRole('button', { name: open }));
      await user.click(await screen.findByRole('button', { name: confirm }));

      const heading = await screen.findByRole('heading', {
        name: copy.strengthSavedNotFinishedHeading,
      });
      const activityRow = heading.closest('li');
      expect(activityRow).not.toBeNull();
      const row = within(activityRow!)
        .getByRole('heading', {
          name: formatMessage(copy.setSummaryHeading, {
            position: 1,
            status: en.setStatus.planned,
          }),
        })
        .closest('li');
      expect(row).not.toBeNull();

      // Listed *because* it holds these, so every one of them is on the screen.
      expectEveryValueVisible(row!);
      await expectEveryValueStored(view.db);

      // Outside every total, and never called nonexistent.
      expect(within(activityRow!).getByText(copy.strengthNoCompletedSets)).toBeInTheDocument();
      expect(screen.queryByText(copy.strengthVolumeLabel)).not.toBeInTheDocument();

      await destroyTestDatabase(view.db);
    },
  );

  /*
   * Structural: the summary is asserted over the same field list the protection guard
   * reads, so a seventh protected field cannot be added without being carried to the
   * screen.
   */
  it.each(RECORDED_SET_FIELDS)(
    'carries %s from an unfinished set into the summary',
    async (field) => {
      const user = userEvent.setup();
      const view = await renderRunningWorkout();
      const card = setCard(1);

      const entries: Record<string, { label: string; typed: string; shown: string }> = {
        reps: { label: copy.repsLabel, typed: '9', shown: '9' },
        durationSeconds: { label: copy.setDurationLabel, typed: '01:30', shown: '01:30' },
        loadValue: { label: copy.loadLabel, typed: '42.5', shown: '42.5 kg' },
        rpe: { label: copy.setRpeLabel, typed: '6', shown: '6 out of 10' },
        rir: { label: copy.setRirLabel, typed: '3', shown: '3' },
        notes: { label: copy.setNotesLabel, typed: NOTE, shown: NOTE },
      };
      const entry = entries[field];
      expect(entry).toBeDefined();

      await user.type(within(card).getByLabelText(entry!.label), entry!.typed);
      await user.click(within(card).getByRole('button', { name: copy.saveSet }));
      await waitFor(async () => {
        expect((await storedSet(view.db))?.[field]).toBeDefined();
      });

      await user.click(screen.getByRole('button', { name: copy.finish }));
      await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

      const heading = await screen.findByRole('heading', {
        name: copy.strengthSavedNotFinishedHeading,
      });
      const activityRow = heading.closest('li');
      expect(within(activityRow!).getByText(entry!.shown)).toBeInTheDocument();

      await destroyTestDatabase(view.db);
    },
  );

  it('reports a finished set with its total and lists it once', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = setCard(1);

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));
    await screen.findByText(en.setStatus.completed);

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    const summaryHeading = await screen.findByRole('heading', {
      name: copy.strengthSummaryHeading,
    });
    const list = summaryHeading.nextElementSibling as HTMLElement;
    expect(within(list).getByText(copy.strengthCompletedSetsOne)).toBeInTheDocument();
    // 60 kg times ten reps, counted as a stack reading, on both sides.
    expect(within(list).getByText('600 kg')).toBeInTheDocument();
    expect(
      within(list).getByText(
        formatMessage(copy.strengthVolumeNote, {
          basis: en.loadBasis.stack_display,
          side: en.bodySide.both,
        }),
      ),
    ).toBeInTheDocument();

    // One row, under one heading.
    expect(
      within(list).getAllByRole('heading', {
        name: formatMessage(copy.setSummaryHeading, {
          position: 1,
          status: en.setStatus.completed,
        }),
      }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole('heading', { name: copy.strengthSavedNotFinishedHeading }),
    ).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('withholds a total that would have no common meaning, and says why', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = setCard(1);

    await user.selectOptions(within(card).getByLabelText(copy.loadBasisLabel), 'unknown');
    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));
    await screen.findByText(en.setStatus.completed);

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    const summaryHeading = await screen.findByRole('heading', {
      name: copy.strengthSummaryHeading,
    });
    const list = summaryHeading.nextElementSibling as HTMLElement;
    expect(within(list).getByText(copy.volumeUnavailable.basis_not_summable)).toBeInTheDocument();
    // The truthful per-set row survives; only the aggregate is withheld.
    expect(within(list).getByText('60 kg')).toBeInTheDocument();
    expect(within(list).getByText(en.loadBasis.unknown)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
