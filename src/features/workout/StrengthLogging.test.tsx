import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import type { StrengthSet } from '../../domain/schemas.ts';
import { toCanonicalGrams } from '../../domain/units.ts';
import { RECORDED_SET_FIELDS } from '../../domain/workout/strength-work.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import {
  addStrengthSet,
  completeStrengthSet,
  updateStrengthSet,
} from '../../db/strength-repository.ts';
import {
  finishSession,
  getTemplateBySeedKey,
  startSessionFromTemplate,
} from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * Recording a strength set.
 *
 * The line these tests hold is the one that matters most on this screen: **a number, its
 * unit, and what it means travel together and are never reinterpreted.** `50 lb` stays
 * fifty pounds; "per side" never quietly becomes "total added"; and the plate-loaded press
 * keeps saying it does not know, because it does not.
 *
 * The draft contract from the segment card is pinned here too -- typed is not saved, an
 * invalid entry stays a draft, a failed write keeps what was typed and offers a retry, and
 * a completed set is closed until it is deliberately reopened.
 */

const START = '2026-09-05T05:00:00.000Z';
const copy = en.pages.workout;

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

async function renderRunningWorkout(
  seed: (db: GymTrackerDatabase) => Promise<void> = startTemplateSession,
): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({
    route: ROUTE_PATHS.workout,
    children: routes(),
    seed,
  });
  await screen.findByRole('heading', { name: 'Seated leg press' });
  return view;
}

/** The panel for one machine, so an assertion cannot read its neighbour's controls. */
function machinePanel(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const panel = heading.closest('section');
  if (!panel) {
    throw new Error(`No panel found for ${name}`);
  }
  return panel;
}

function setCard(panel: HTMLElement, position: number): HTMLElement {
  const heading = within(panel).getByRole('heading', {
    name: formatMessage(copy.setHeading, { position }),
  });
  const card = heading.closest('li');
  if (!card) {
    throw new Error(`No card found for set ${String(position)}`);
  }
  return card;
}

async function addSetTo(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<HTMLElement> {
  await user.click(within(machinePanel(name)).getByRole('button', { name: copy.addSet }));
  await waitFor(() => {
    expect(within(machinePanel(name)).getByRole('heading', { name: 'Set 1' })).toBeInTheDocument();
  });
  return setCard(machinePanel(name), 1);
}

async function storedSets(db: GymTrackerDatabase): Promise<StrengthSet[]> {
  return (await db.strengthSets.toArray()).sort((a, b) => a.position - b.position);
}

describe('the fields of a set', () => {
  it('gives every control its own accessible name', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    for (const label of [
      copy.setTypeLabel,
      copy.sideLabel,
      copy.repsLabel,
      copy.setDurationLabel,
      copy.loadBasisLabel,
      copy.loadLabel,
      copy.loadUnitLabel,
    ]) {
      expect(within(card).getByLabelText(label)).toBeInTheDocument();
    }
    // The optional three live behind a disclosure, but they are still labelled.
    expect(within(card).getByLabelText(copy.setRpeLabel)).toBeInTheDocument();
    expect(within(card).getByLabelText(copy.setRirLabel)).toBeInTheDocument();
    expect(within(card).getByLabelText(copy.setNotesLabel)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('starts with the machine defaults and nothing filled in', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    expect(within(card).getByLabelText(copy.setTypeLabel)).toHaveValue('working');
    expect(within(card).getByLabelText(copy.sideLabel)).toHaveValue('both');
    expect(within(card).getByLabelText(copy.loadBasisLabel)).toHaveValue('stack_display');
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('');
    expect(within(card).getByLabelText(copy.loadLabel)).toHaveValue('');
    expect(within(card).getByText(en.setStatus.planned)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('names the failing field and keeps the draft when a value cannot be parsed', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    const reps = within(card).getByLabelText(copy.repsLabel);
    await user.type(reps, '8.5');
    await user.tab();

    const error = await within(card).findByText(en.validation.wholeNumber);
    expect(error).toBeInTheDocument();
    expect(reps).toHaveAttribute('aria-invalid', 'true');
    expect(reps).toHaveDescription(en.validation.wholeNumber);
    // The draft is still there to correct; nothing was stored.
    expect(reps).toHaveValue('8.5');
    expect((await storedSets(view.db))[0]?.reps).toBeUndefined();

    await destroyTestDatabase(view.db);
  });
});

describe('what the number means', () => {
  /*
   * The plate-loaded press arrives with `unknown` deliberately. Defaulting it to per-side
   * or total-added would put a specific claim into every set logged on it.
   */
  it('says the plate-loaded press does not know yet, and stores that', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const panel = machinePanel('Plate-loaded leg press');

    expect(within(panel).getByText(en.loadBasisExplanation.unknown)).toBeInTheDocument();
    expect(within(panel).getByText(copy.strengthUnknownBasisNote)).toBeInTheDocument();

    const card = await addSetTo(user, 'Plate-loaded leg press');
    expect(within(card).getByLabelText(copy.loadBasisLabel)).toHaveValue('unknown');
    expect((await storedSets(view.db))[0]?.loadBasis).toBe('unknown');

    await destroyTestDatabase(view.db);
  });

  it('records per-side and total-added as different things', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const first = await addSetTo(user, 'Plate-loaded leg press');

    await user.selectOptions(within(first).getByLabelText(copy.loadBasisLabel), 'per_side');
    await user.type(within(first).getByLabelText(copy.loadLabel), '60');
    await user.type(within(first).getByLabelText(copy.repsLabel), '10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.loadBasis).toBe('per_side');
    });

    const panel = machinePanel('Plate-loaded leg press');
    await user.click(within(panel).getByRole('button', { name: copy.addSet }));
    await waitFor(() => {
      expect(
        within(machinePanel('Plate-loaded leg press')).getByRole('heading', { name: 'Set 2' }),
      ).toBeInTheDocument();
    });
    const second = setCard(machinePanel('Plate-loaded leg press'), 2);
    await user.selectOptions(within(second).getByLabelText(copy.loadBasisLabel), 'total_added');
    await user.type(within(second).getByLabelText(copy.loadLabel), '60');
    await user.tab();

    await waitFor(async () => {
      const sets = await storedSets(view.db);
      expect(sets.map((set) => set.loadBasis)).toEqual(['per_side', 'total_added']);
    });
    // The same 60 with two different meanings, and both meanings are on the screen.
    expect(within(first).getByText(en.loadBasisExplanation.per_side)).toBeInTheDocument();
    expect(within(second).getByText(en.loadBasisExplanation.total_added)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('hides the weight for a bodyweight set and stores no load with it', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.loadLabel), '40');
    await user.selectOptions(within(card).getByLabelText(copy.loadBasisLabel), 'bodyweight');

    expect(within(card).queryByLabelText(copy.loadLabel)).not.toBeInTheDocument();
    expect(within(card).getByText(copy.bodyweightNoLoadTitle)).toBeInTheDocument();

    await user.type(within(card).getByLabelText(copy.repsLabel), '12');
    await user.tab();

    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.loadBasis).toBe('bodyweight');
      // Absent, not zero: nothing was loaded onto a machine nobody loaded.
      expect(stored?.loadValue).toBeUndefined();
      expect(stored?.loadGrams).toBeUndefined();
    });

    await destroyTestDatabase(view.db);
  });
});

describe('the unit toggle', () => {
  it('converts the visible draft rather than relabelling it', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    // The unit is chosen first, so 50 is entered as fifty pounds.
    await user.selectOptions(within(card).getByLabelText(copy.loadUnitLabel), 'lb');
    await user.type(within(card).getByLabelText(copy.loadLabel), '50');
    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.tab();

    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.loadValue).toBe(50);
      expect(stored?.loadUnit).toBe('lb');
      // The whole point: 50 lb is not 50 kg.
      expect(stored?.loadGrams).toBe(toCanonicalGrams(50, 'lb'));
      expect(stored?.loadGrams).not.toBe(50_000);
    });

    // Switching back converts what is on screen; it does not restore the old label.
    await user.selectOptions(within(card).getByLabelText(copy.loadUnitLabel), 'kg');
    expect(within(card).getByLabelText(copy.loadLabel)).toHaveValue('22.68');

    await destroyTestDatabase(view.db);
  });

  it('steps the load by the configured increment and never below zero', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const increase = within(card).getByRole('button', {
      name: formatMessage(copy.increaseLoad, { value: '2.5', unit: 'kg' }),
    });
    const decrease = within(card).getByRole('button', {
      name: formatMessage(copy.decreaseLoad, { value: '2.5', unit: 'kg' }),
    });

    await user.click(increase);
    await user.click(increase);
    expect(within(card).getByLabelText(copy.loadLabel)).toHaveValue('5');

    await user.click(decrease);
    await user.click(decrease);
    await user.click(decrease);
    expect(within(card).getByLabelText(copy.loadLabel)).toHaveValue('0');

    await destroyTestDatabase(view.db);
  });
});

describe('a completed set is closed until it is reopened', () => {
  it('marks the set done with its final values and locks the fields', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.status).toBe('completed');
      expect(stored?.reps).toBe(10);
      expect(stored?.loadValue).toBe(60);
      expect(stored?.completedAt).toBe(START);
    });

    await within(machinePanel('Seated leg press')).findByText(en.setStatus.completed);
    const done = setCard(machinePanel('Seated leg press'), 1);
    expect(within(done).getByLabelText(copy.repsLabel)).toBeDisabled();
    expect(within(done).getByLabelText(copy.loadUnitLabel)).toBeDisabled();
    expect(within(done).queryByRole('button', { name: copy.saveSet })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('refuses to complete a set with no measurable work and says why', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    expect(await within(card).findByText(copy.completeSetNeedsWorkError)).toBeInTheDocument();
    expect((await storedSets(view.db))[0]?.status).toBe('planned');

    await destroyTestDatabase(view.db);
  });

  it('reopens without losing anything', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));
    await screen.findByText(en.setStatus.completed);

    await user.click(
      within(setCard(machinePanel('Seated leg press'), 1)).getByRole('button', {
        name: copy.reopenSet,
      }),
    );

    await waitFor(() => {
      const reopened = setCard(machinePanel('Seated leg press'), 1);
      expect(within(reopened).getByText(en.setStatus.planned)).toBeInTheDocument();
      expect(within(reopened).getByLabelText(copy.repsLabel)).toHaveValue('10');
      expect(within(reopened).getByLabelText(copy.loadLabel)).toHaveValue('60');
    });

    await destroyTestDatabase(view.db);
  });
});

describe('nothing recorded is deleted to make an action succeed', () => {
  it.each([
    ['skip', copy.skipSet, copy.skipSetBlockedTitle],
    ['remove', copy.removeSet, copy.removeSetBlockedTitle],
  ] as const)(
    'refuses to %s a set holding a note, and says which',
    async (_action, button, title) => {
      const user = userEvent.setup();
      const view = await renderRunningWorkout();
      const card = await addSetTo(user, 'Seated leg press');

      await user.type(within(card).getByLabelText(copy.setNotesLabel), 'Adjusted the seat');
      await user.click(within(card).getByRole('button', { name: copy.saveSet }));
      await waitFor(async () => {
        expect((await storedSets(view.db))[0]?.notes).toBe('Adjusted the seat');
      });

      await user.click(
        within(setCard(machinePanel('Seated leg press'), 1)).getByRole('button', { name: button }),
      );
      if (button === copy.removeSet) {
        await user.click(await screen.findByRole('button', { name: copy.removeSetDialogConfirm }));
      }

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(await screen.findByText(copy.setRecordedWorkBlockedBody)).toBeInTheDocument();
      const stored = await storedSets(view.db);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe('planned');
      expect(stored[0]?.notes).toBe('Adjusted the seat');

      await destroyTestDatabase(view.db);
    },
  );

  it('removes a set that really holds nothing', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    await addSetTo(user, 'Seated leg press');

    await user.click(
      within(setCard(machinePanel('Seated leg press'), 1)).getByRole('button', {
        name: copy.removeSet,
      }),
    );
    await user.click(await screen.findByRole('button', { name: copy.removeSetDialogConfirm }));

    await waitFor(async () => {
      expect(await storedSets(view.db)).toHaveLength(0);
    });

    await destroyTestDatabase(view.db);
  });
});

describe('a failed write keeps what was typed', () => {
  it('reports the failure, keeps the draft, and retries the same operation', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    const put = vi.spyOn(view.db.strengthSets, 'put').mockRejectedValueOnce(new Error('quota'));
    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.click(within(card).getByRole('button', { name: copy.saveSet }));

    expect(await within(card).findByText(copy.saveFailedBody)).toBeInTheDocument();
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect((await storedSets(view.db))[0]?.reps).toBeUndefined();
    put.mockRestore();

    await user.click(within(card).getByRole('button', { name: copy.retry }));
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    await destroyTestDatabase(view.db);
  });

  /*
   * The queue guarantees order, not success. A removal that merely followed a failed save
   * would ask the repository about a row that never received the value, and its guard
   * would happily delete what the user can see.
   */
  it('will not remove a set whose latest change never reached the database', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    const put = vi.spyOn(view.db.strengthSets, 'put').mockRejectedValue(new Error('quota'));
    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.click(within(card).getByRole('button', { name: copy.removeSet }));
    await user.click(await screen.findByRole('button', { name: copy.removeSetDialogConfirm }));

    expect(await screen.findByText(copy.setUnsavedBlockedBody)).toBeInTheDocument();
    expect(await storedSets(view.db)).toHaveLength(1);
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('10');
    put.mockRestore();

    await destroyTestDatabase(view.db);
  });
});

describe('adding and copying', () => {
  it('proposes the previous set in a new row without recording anything', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.type(within(card).getByLabelText(copy.setNotesLabel), 'form broke down');
    await user.click(within(card).getByRole('button', { name: copy.saveSet }));
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.copyLastSet }),
    );

    await waitFor(async () => {
      const sets = await storedSets(view.db);
      expect(sets).toHaveLength(2);
      expect(sets[1]).toMatchObject({
        status: 'planned',
        plannedReps: 10,
        plannedLoadValue: 60,
      });
    });

    // The row proposes the numbers and records none of them.
    const copied = (await storedSets(view.db))[1];
    for (const field of RECORDED_SET_FIELDS) {
      expect(copied?.[field]).toBeUndefined();
    }

    // The fields still open on the proposal, so accepting it stays one tap -- and the
    // card says plainly that nothing here has been recorded.
    await waitFor(() => {
      expect(
        within(machinePanel('Seated leg press')).getByRole('heading', { name: 'Set 2' }),
      ).toBeInTheDocument();
    });
    const secondCard = setCard(machinePanel('Seated leg press'), 2);
    expect(within(secondCard).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect(within(secondCard).getByLabelText(copy.loadLabel)).toHaveValue('60');
    expect(within(secondCard).getByText(copy.saveStateProposed)).toBeInTheDocument();
    expect(within(secondCard).getByText(copy.setProposedNote)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  /*
   * A thumb produces two clicks far more often than a mouse does, and both handlers run
   * before React applies a single `setState`. The guard is a synchronous ref, not the
   * disabled attribute.
   */
  it('creates one row when Add set is double-tapped', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const button = within(machinePanel('Seated leg press')).getByRole('button', {
      name: copy.addSet,
    });

    await Promise.all([user.click(button), user.click(button)]);

    await waitFor(async () => {
      expect(await storedSets(view.db)).toHaveLength(1);
    });

    await destroyTestDatabase(view.db);
  });
});

describe('the last comparable result and personal bests', () => {
  function withHistory(load: number, reps: number): (db: GymTrackerDatabase) => Promise<void> {
    return async (db: GymTrackerDatabase): Promise<void> => {
      const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
      const earlier = await startSessionFromTemplate(db, template?.id ?? '', {
        clock: createFixedClock('2026-09-01T05:00:00.000Z'),
        ids: createSequentialIdProvider(1000),
        timeZone: 'Asia/Tbilisi',
        utcOffsetMinutes: 240,
      });
      const activity = earlier.activities.find(
        (candidate) => candidate.displayName === 'Seated leg press',
      );
      const set = await addStrengthSet(db, activity?.id ?? '', {
        clock: createFixedClock('2026-09-01T05:00:00.000Z'),
      });
      await completeStrengthSet(
        db,
        set.id,
        { reps, loadValue: load, loadUnit: 'kg', loadGrams: toCanonicalGrams(load, 'kg') },
        { clock: createFixedClock('2026-09-01T05:10:00.000Z') },
      );
      await finishSession(db, earlier.session.id, {
        clock: createFixedClock('2026-09-01T06:00:00.000Z'),
      });
      await startTemplateSession(db);
    };
  }

  it('shows the previous result in the unit it was recorded in, beside the fields', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout(withHistory(60, 10));
    const card = await addSetTo(user, 'Seated leg press');

    const previous = within(card).getByText(/60 kg/);
    expect(previous).toHaveTextContent(en.loadBasis.stack_display);
    expect(previous).toHaveTextContent('10 reps');

    await destroyTestDatabase(view.db);
  });

  it('says plainly when there is nothing comparable yet', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    expect(within(card).getByText(copy.previousNone)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('will not compare a set whose meaning was never recorded', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout(withHistory(60, 10));
    const card = await addSetTo(user, 'Seated leg press');

    await user.selectOptions(within(card).getByLabelText(copy.loadBasisLabel), 'unknown');
    expect(within(card).getByText(copy.previousNotComparable)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('names a heavier load a best and explains what it compared', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout(withHistory(60, 10));
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '8');
    await user.type(within(card).getByLabelText(copy.loadLabel), '65');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    const done = await screen.findByText(new RegExp(copy.recordLoadHigher));
    expect(done).toBeInTheDocument();
    // Every badge says what it rests on.
    expect(
      screen.getByText(new RegExp('Compared with 1 earlier finished set')),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('gives no badge to a first result, and names it a first result', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    expect(await screen.findByText(copy.firstComparableResult)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(copy.recordLoadHigher))).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('gives no badge when the earlier work was on a different meaning', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout(withHistory(60, 10));
    const card = await addSetTo(user, 'Seated leg press');

    await user.selectOptions(within(card).getByLabelText(copy.loadBasisLabel), 'per_side');
    await user.type(within(card).getByLabelText(copy.repsLabel), '8');
    await user.type(within(card).getByLabelText(copy.loadLabel), '100');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    expect(await screen.findByText(copy.firstComparableResult)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(copy.recordLoadHigher))).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('the rest timer', () => {
  it('appears after a set is finished and blocks nothing', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    expect(screen.queryByText(copy.restHeading)).not.toBeInTheDocument();

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    const panel = await waitFor(() => {
      const found = machinePanel('Seated leg press');
      expect(within(found).getByText(copy.restHeading)).toBeInTheDocument();
      return found;
    });
    expect(within(panel).getByText(copy.restNote)).toBeInTheDocument();

    // Logging continues while it counts down; nothing here is disabled by the timer.
    const addSet = within(panel).getByRole('button', { name: copy.addSet });
    expect(addSet).toBeEnabled();
    await user.click(addSet);
    await waitFor(async () => {
      expect(await storedSets(view.db)).toHaveLength(2);
    });
    expect(
      within(machinePanel('Seated leg press')).getByText(copy.restHeading),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));
    const dismiss = await screen.findByRole('button', { name: copy.restDismiss });
    await user.click(dismiss);

    expect(screen.queryByText(copy.restHeading)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('a reload restores every set and the current draft', () => {
  it('shows what was stored, exactly as it was entered', async () => {
    const view = await renderRunningWorkout(async (db) => {
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
      const done = await addStrengthSet(db, activity?.id ?? '', {
        clock: createFixedClock(START),
      });
      await completeStrengthSet(
        db,
        done.id,
        { reps: 10, loadValue: 50, loadUnit: 'lb', loadGrams: toCanonicalGrams(50, 'lb') },
        { clock: createFixedClock(START) },
      );
      const draft = await addStrengthSet(db, activity?.id ?? '', {
        clock: createFixedClock(START),
      });
      await updateStrengthSet(db, draft.id, { reps: 8 }, { clock: createFixedClock(START) });
    });

    const panel = machinePanel('Seated leg press');
    const completed = setCard(panel, 1);
    expect(within(completed).getByLabelText(copy.loadLabel)).toHaveValue('50');
    expect(within(completed).getByLabelText(copy.loadUnitLabel)).toHaveValue('lb');
    expect(within(completed).getByText(en.setStatus.completed)).toBeInTheDocument();

    const planned = setCard(panel, 2);
    expect(within(planned).getByLabelText(copy.repsLabel)).toHaveValue('8');
    expect(within(planned).getByText(copy.saveStateSaved)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

/**
 * Holds the next read-write transaction open until the returned function is called.
 *
 * The point is to make one save genuinely outstanding while the user carries on typing,
 * which is the only way to reproduce the original defect: a second blur arriving while
 * the first save is still running. Reads pass through untouched, so the page keeps
 * rendering normally while the write waits.
 */
function holdFirstWrite(db: GymTrackerDatabase): () => void {
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
  return release;
}

/**
 * Two blurs are two draft revisions, not one action asked for twice.
 *
 * Both cards used to guard every write with a single key and drop anything already
 * outstanding under it. Every field blur asks for `save`, so blurring reps and then weight
 * while the first write was in flight stored the reps and silently discarded the weight --
 * and the card, having recorded no failure, never retried it. A reload lost a number the
 * user had entered and watched the app accept.
 */
describe('two fields blurred while the first save is still running', () => {
  it('stores both values, newest last', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    const release = holdFirstWrite(view.db);

    // Blur one: reps. The write starts and is held open.
    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();

    // Blur two, carrying a later revision, while the first is still outstanding.
    await user.click(within(card).getByLabelText(copy.loadLabel));
    await user.keyboard('60');
    await user.tab();

    release();

    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.reps).toBe(10);
      expect(stored?.loadValue).toBe(60);
    });
    // Read back from the database rather than the screen: what survives a reload is the
    // only thing this test is about.
    const stored = (await storedSets(view.db))[0];
    expect(stored?.loadUnit).toBe('kg');
    expect(stored?.loadGrams).toBe(toCanonicalGrams(60, 'kg'));

    await destroyTestDatabase(view.db);
  });

  it('still writes once when a blur and the Save button ask for the same draft', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    /*
     * The write is held so both requests are genuinely concurrent, which is the situation
     * the duplicate guard exists for and the only one in which "one write" is a rule
     * rather than a coincidence of timing.
     */
    const release = holdFirstWrite(view.db);
    const put = vi.spyOn(view.db.strengthSets, 'put');

    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    // The click blurs the field first, so two requests arrive for one identical draft.
    await user.click(within(card).getByRole('button', { name: copy.saveSet }));
    release();

    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    expect(put).toHaveBeenCalledTimes(1);
    put.mockRestore();

    await destroyTestDatabase(view.db);
  });

  it('completes with the value in a field that was never blurred', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '12');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.status).toBe('completed');
      expect(stored?.reps).toBe(12);
    });

    await destroyTestDatabase(view.db);
  });

  it('records one completion when Mark done is tapped twice', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.type(within(card).getByLabelText(copy.repsLabel), '12');
    const complete = within(card).getByRole('button', { name: copy.completeSet });
    await user.dblClick(complete);

    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.status).toBe('completed');
    });
    const stored = (await storedSets(view.db))[0];
    // Idempotent in the database as well as guarded in the card: a repeated request for a
    // state the record already holds must not become a second, later completion time.
    expect(stored?.completedAt).toBe(START);

    await destroyTestDatabase(view.db);
  });
});

/**
 * A copied set is a suggestion until somebody answers it.
 *
 * The original defect: one tap of Copy last set produced a row the app treated as
 * completed work -- it refused to remove or skip it, and the finish summary
 * printed its numbers as values he had entered.
 */
describe('answering a copied set', () => {
  async function copyOfACompletedSet(
    user: ReturnType<typeof userEvent.setup>,
    db: GymTrackerDatabase,
  ): Promise<HTMLElement> {
    const card = await addSetTo(user, 'Seated leg press');
    await user.type(within(card).getByLabelText(copy.repsLabel), '10');
    await user.type(within(card).getByLabelText(copy.loadLabel), '60');
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));
    await waitFor(async () => {
      expect((await storedSets(db))[0]?.status).toBe('completed');
    });

    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.copyLastSet }),
    );
    await waitFor(() => {
      expect(
        within(machinePanel('Seated leg press')).getByRole('heading', { name: 'Set 2' }),
      ).toBeInTheDocument();
    });
    return setCard(machinePanel('Seated leg press'), 2);
  }

  it('can be removed, because the user recorded nothing in it', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await copyOfACompletedSet(user, view.db);

    await user.click(within(card).getByRole('button', { name: copy.removeSet }));
    await user.click(await screen.findByRole('button', { name: copy.removeSetDialogConfirm }));

    await waitFor(async () => {
      expect(await storedSets(view.db)).toHaveLength(1);
    });
    // And no refusal was shown, because there was nothing to refuse on.
    expect(screen.queryByText(copy.setRecordedWorkBlockedBody)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('can be skipped, because the user recorded nothing in it', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await copyOfACompletedSet(user, view.db);

    await user.click(within(card).getByRole('button', { name: copy.skipSet }));

    await waitFor(async () => {
      expect((await storedSets(view.db))[1]?.status).toBe('skipped');
    });
    expect(screen.queryByText(copy.setRecordedWorkBlockedBody)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('becomes exactly one recorded result when it is marked done', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await copyOfACompletedSet(user, view.db);

    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    await waitFor(async () => {
      expect((await storedSets(view.db))[1]?.status).toBe('completed');
    });
    const stored = await storedSets(view.db);
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({ reps: 10, loadValue: 60, loadUnit: 'kg' });
    // The proposal is answered, so it is gone.
    expect(stored[1]?.plannedReps).toBeUndefined();
    expect(stored[1]?.plannedLoadValue).toBeUndefined();

    await destroyTestDatabase(view.db);
  });

  it('keeps a field the user emptied empty', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await copyOfACompletedSet(user, view.db);

    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.click(within(card).getByRole('button', { name: copy.saveSet }));

    await waitFor(async () => {
      expect((await storedSets(view.db))[1]?.loadValue).toBe(60);
    });
    const stored = (await storedSets(view.db))[1];
    expect(stored?.reps).toBeUndefined();
    expect(stored?.plannedReps).toBeUndefined();
    // The field stays empty on screen: nothing refills it from the proposal.
    expect(
      within(setCard(machinePanel('Seated leg press'), 2)).getByLabelText(copy.repsLabel),
    ).toHaveValue('');

    await destroyTestDatabase(view.db);
  });
});

/**
 * The stale-write race, on a real card and a real database.
 *
 * The coordinator dropped any save whose revision matched the
 * write in flight, which is only a duplicate when nothing different is queued. Typing a
 * value, changing it, and changing it back while the first write was still running
 * discarded the user's newest draft and let the middle one win — so a value they had just
 * put back was overwritten by the one they had moved away from, and it survived a reload.
 */
describe('changing a field and changing it back while the first save is held', () => {
  it('stores what the user went back to, not the revision queued in between', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    const release = holdFirstWrite(view.db);

    // A: ten reps. The write starts and is held open.
    await user.click(reps);
    await user.keyboard('10');
    await user.tab();

    // B: a correction, which queues behind the held write.
    await user.clear(reps);
    await user.keyboard('12');
    await user.tab();

    // Back to A. This is the newest truth on the screen, and it was being discarded.
    await user.clear(reps);
    await user.keyboard('10');
    await user.tab();

    release();

    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    // Held for a moment, because the defect was that a later write arrived and changed it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await storedSets(view.db))[0]?.reps).toBe(10);

    // And the database on its own holds it: unmounted, closed, and opened again.
    view.unmount();
    view.db.close();
    await view.db.open();
    const reopened = await view.db.strengthSets.toArray();
    expect(reopened[0]?.reps).toBe(10);

    await destroyTestDatabase(view.db);
  });

  it('keeps the load trio consistent when the weight is changed and changed back', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const load = within(card).getByLabelText(copy.loadLabel);

    const release = holdFirstWrite(view.db);

    await user.click(load);
    await user.keyboard('60');
    await user.tab();

    await user.clear(load);
    await user.keyboard('65');
    await user.tab();

    await user.clear(load);
    await user.keyboard('60');
    await user.tab();

    release();

    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.loadValue).toBe(60);
    });
    // The load is three fields that travel together, so the canonical form has to agree.
    const stored = (await storedSets(view.db))[0];
    expect(stored?.loadUnit).toBe('kg');
    expect(stored?.loadGrams).toBe(toCanonicalGrams(60, 'kg'));

    await destroyTestDatabase(view.db);
  });
});
