import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFixedClock, createSteppingClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import type { CardioSegment, StrengthSet, WorkoutSession } from '../../domain/schemas.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { updateStrengthSet } from '../../db/strength-repository.ts';
import { getTemplateBySeedKey, startSessionFromTemplate } from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * Who owns the fields while a write is still in the air.
 *
 * Every other component test on this screen injects a **fixed** clock, so a record's
 * `updatedAt` is byte-identical after every write and the branch that adopts an incoming
 * record never executes at all. The whole draft-adoption path was therefore untested,
 * however many green tests surrounded it -- and it held a defect that could replace the
 * user's newest correction with the value they had just moved away from.
 *
 * So every test in this file runs on `createSteppingClock`. Each write really does change
 * `updatedAt`, the card really does re-render against a changed record, and the adoption
 * rule really is exercised.
 *
 * The ordering under test is an ordinary correction at a machine: save `10`, change it to
 * `12`, change it back to `10` before the `12` write lands. The card used to decide it was
 * untouched -- the draft equalled the values last adopted -- and replace the field with
 * `12`. The following blur then found the draft equal to the record and wrote nothing, so
 * the screen and the database both ended at a number the user had rejected.
 */

const START = '2026-09-07T05:00:00.000Z';
const copy = en.pages.workout;
const strings = en;

function routes(): React.ReactNode {
  return (
    <Routes>
      <Route
        path={ROUTE_PATHS.workout}
        element={
          <WorkoutPage
            clock={createSteppingClock(START, 1000)}
            ids={createSequentialIdProvider(9000)}
          />
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
  await screen.findByRole('heading', { name: 'Seated leg press' });
  return view;
}

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

async function storedSegment(
  db: GymTrackerDatabase,
  position: number,
): Promise<CardioSegment | undefined> {
  const all = await db.cardioSegments.toArray();
  return all.sort((a, b) => a.position - b.position)[position];
}

/**
 * Holds a read-write transaction open until it is released. Reads pass through.
 *
 * This is what makes "a write is still in flight" a fact the test controls rather than a
 * coincidence of scheduling.
 *
 * `skip` chooses *which* write, because a terminal action is several in a row: Finish
 * flushes every card that is holding something and only then writes the session. Passing
 * the number of flushes that must land first opens the window on the one under test --
 * `skip: 1` holds the second card's flush while the first has already returned, and a skip
 * of `0` against clean drafts holds the session write itself.
 */
function holdNextWrite(db: GymTrackerDatabase, skip = 0): () => void {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = (): void => {
      resolve();
    };
  });
  const real = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  let held = false;
  let seen = 0;
  const spy = vi.spyOn(db, 'transaction') as unknown as {
    mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
  };
  spy.mockImplementation((...args: unknown[]) => {
    if (args[0] === 'rw' && !held && seen++ >= skip) {
      held = true;
      return gate.then(() => real(...args));
    }
    return real(...args);
  });
  return release;
}

/**
 * Makes the next read-write transaction reject, once. Everything after it goes through.
 *
 * A refused terminal write is not a hypothetical: a full disk or a database the browser
 * has evicted produces exactly this, and it is the path on which every card has to become
 * editable again rather than staying frozen behind a workout that never closed.
 */
function failNextWrite(db: GymTrackerDatabase, skip = 0): void {
  const real = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  let failed = false;
  let seen = 0;
  const spy = vi.spyOn(db, 'transaction') as unknown as {
    mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
  };
  spy.mockImplementation((...args: unknown[]) => {
    if (args[0] === 'rw' && !failed && seen++ >= skip) {
      failed = true;
      return Promise.reject(new Error('The database refused this write'));
    }
    return real(...args);
  });
}

async function storedSessions(db: GymTrackerDatabase): Promise<WorkoutSession[]> {
  return db.workoutSessions.toArray();
}

/**
 * Waits for a card to report that it has nothing outstanding.
 *
 * A stored value appearing in IndexedDB proves the write landed. It does not prove the
 * card's queue is empty, and it does not prove the page has reloaded -- `waitFor` on the
 * database resolves before the card has even called `onChanged`, so the reload settles
 * during whatever the test does next, outside its own `act` boundary. `Saved` is the card
 * comparing its draft with the `set` prop, so it is true only once that reload has arrived:
 * an assertion about the thing being waited for, rather than a pause hoping for it.
 */
async function saveStateSettled(card: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(card.querySelector('.set__save-state, .segment__save-state')).toHaveTextContent(
      copy.saveStateSaved,
    );
  });
}

/** What a field is showing right now, so an assertion can compare the screen to the disk. */
function visibleValue(card: HTMLElement, label: string): string {
  return within(card).getByLabelText<HTMLInputElement>(label).value;
}

/** Reads the row back from a freshly opened database, so nothing in memory can answer. */
async function afterReopen<T>(
  view: Awaited<ReturnType<typeof renderWithDatabase>>,
  read: (db: GymTrackerDatabase) => Promise<T>,
): Promise<T> {
  view.unmount();
  view.db.close();
  await view.db.open();
  return read(view.db);
}

describe('a landing write and a newer local edit — a strength set', () => {
  /*
   * Matrix 2: the older write lands *before* the final blur, which is the window in which
   * the card decides whether to adopt. This is the ordering that triggered the bug.
   */
  it('keeps a correction typed while the older write was still in flight', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    // A: saved, landed, and adopted. The draft and the record now agree on 10.
    await user.click(reps);
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    // B: starts and is held open.
    const release = holdNextWrite(view.db);
    await user.clear(reps);
    await user.keyboard('12');
    await user.tab();

    // The correction, typed while B is outstanding and not yet blurred.
    await user.clear(reps);
    await user.keyboard('10');

    // B lands. The draft equals the values last adopted, and it is still the user's.
    release();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(12);
    });
    expect(reps).toHaveValue('10');

    // Now the blur. It has something to write, because the draft is owned.
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(10);
    await destroyTestDatabase(view.db);
  });

  /* Matrix 3: the same correction, blurred *before* the older write lands. */
  it('keeps a correction blurred before the older write lands', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    await user.click(reps);
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    const release = holdNextWrite(view.db);
    await user.clear(reps);
    await user.keyboard('12');
    await user.tab();

    await user.clear(reps);
    await user.keyboard('10');
    await user.tab();

    release();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    /*
     * Held, so a later write arriving would be caught rather than waited past. The window
     * sits inside `act` because the queued write really does settle during it: this is a
     * pause the test expects renders in, not one it expects silence in.
     */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect((await storedSets(view.db))[0]?.reps).toBe(10);
    expect(reps).toHaveValue('10');

    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(10);
    await destroyTestDatabase(view.db);
  });

  /*
   * Matrix 4: the load trio, where the number, its unit, and the canonical grams derived
   * from that exact pair must not be able to separate.
   */
  it('keeps a load the user went back to, with its unit and its canonical grams', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const load = within(card).getByLabelText(copy.loadLabel);

    await user.click(load);
    await user.keyboard('60');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.loadValue).toBe(60);
    });

    const release = holdNextWrite(view.db);
    await user.clear(load);
    await user.keyboard('65');
    await user.tab();

    await user.clear(load);
    await user.keyboard('60');

    release();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.loadValue).toBe(65);
    });
    expect(load).toHaveValue('60');

    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.loadValue).toBe(60);
    });

    const stored = (await afterReopen(view, storedSets))[0];
    expect(stored?.loadValue).toBe(60);
    expect(stored?.loadUnit).toBe('kg');
    expect(stored?.loadGrams).toBe(60_000);
    await destroyTestDatabase(view.db);
  });

  /*
   * Matrix 5: the newer draft does not have to *equal* the previously adopted value for
   * ownership to matter. A landing write must not overwrite any newer local edit.
   */
  it('never adopts a landing record over a different newer draft', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    await user.click(reps);
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    const release = holdNextWrite(view.db);
    await user.clear(reps);
    await user.keyboard('12');
    await user.tab();

    await user.clear(reps);
    await user.keyboard('14');

    release();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(12);
    });
    expect(reps).toHaveValue('14');

    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(14);
    });

    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(14);
    await destroyTestDatabase(view.db);
  });
});

describe('handing ownership back', () => {
  /*
   * Matrix 6: ownership is not a one-way door. Once the draft on screen has been stored,
   * the card is clean again and a change that arrives from the database is adopted.
   */
  it('adopts a stored change once the draft the user typed has been saved', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    await user.click(reps);
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    await saveStateSettled(card);

    // A change from outside this card, such as an edit from the history view.
    const stored = (await storedSets(view.db))[0];
    await updateStrengthSet(
      view.db,
      stored?.id ?? '',
      { reps: 15 },
      { clock: createSteppingClock('2026-09-07T06:00:00.000Z', 1000) },
    );

    // Anything that reloads the session brings it to the card.
    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.addSet }),
    );

    await waitFor(() => {
      expect(
        within(setCard(machinePanel('Seated leg press'), 1)).getByLabelText(copy.repsLabel),
      ).toHaveValue('15');
    });

    await destroyTestDatabase(view.db);
  });

  /*
   * Matrix 7: a write that failed acknowledged nothing, so the entry stays the user's --
   * on the screen, out of the way of an incoming record, and retryable. Retrying that
   * exact revision is what makes it durable and hands ownership back.
   */
  it('keeps a failed draft owned and visible, and Retry makes that revision durable', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    const put = vi.spyOn(view.db.strengthSets, 'put').mockRejectedValueOnce(new Error('quota'));
    await user.click(reps);
    await user.keyboard('10');
    await user.click(within(card).getByRole('button', { name: copy.saveSet }));

    expect(await within(card).findByText(copy.saveFailedBody)).toBeInTheDocument();
    expect(reps).toHaveValue('10');
    expect((await storedSets(view.db))[0]?.reps).toBeUndefined();
    put.mockRestore();

    await user.click(within(card).getByRole('button', { name: copy.retry }));
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    await saveStateSettled(card);
    expect(reps).toHaveValue('10');

    // Clean again: a change arriving from the database is adopted rather than held off.
    const stored = (await storedSets(view.db))[0];
    await updateStrengthSet(
      view.db,
      stored?.id ?? '',
      { reps: 15 },
      { clock: createSteppingClock('2026-09-07T06:00:00.000Z', 1000) },
    );
    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.addSet }),
    );
    await waitFor(() => {
      expect(
        within(setCard(machinePanel('Seated leg press'), 1)).getByLabelText(copy.repsLabel),
      ).toHaveValue('15');
    });

    await destroyTestDatabase(view.db);
  });

  /* Matrix 8: nothing here may cost the card the behaviour it already had. */
  it('follows the database when the user has made no edit at all', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    await addSetTo(user, 'Seated leg press');

    const stored = (await storedSets(view.db))[0];
    await updateStrengthSet(
      view.db,
      stored?.id ?? '',
      { reps: 8, loadValue: 45, loadUnit: 'kg', loadGrams: 45_000 },
      { clock: createSteppingClock('2026-09-07T06:00:00.000Z', 1000) },
    );
    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.addSet }),
    );

    await waitFor(() => {
      const first = setCard(machinePanel('Seated leg press'), 1);
      expect(within(first).getByLabelText(copy.repsLabel)).toHaveValue('8');
      expect(within(first).getByLabelText(copy.loadLabel)).toHaveValue('45');
    });

    await destroyTestDatabase(view.db);
  });

  it('begins a copied proposal clean, so a stored change still reaches it', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.copyLastSet }),
    );
    await waitFor(() => {
      expect(
        within(machinePanel('Seated leg press')).getByRole('heading', { name: 'Set 2' }),
      ).toBeInTheDocument();
    });
    // The proposal prefills the form and is nobody's edit.
    expect(
      within(setCard(machinePanel('Seated leg press'), 2)).getByLabelText(copy.repsLabel),
    ).toHaveValue('10');

    const copied = (await storedSets(view.db))[1];
    await updateStrengthSet(
      view.db,
      copied?.id ?? '',
      { plannedReps: 9 },
      { clock: createSteppingClock('2026-09-07T06:00:00.000Z', 1000) },
    );
    await user.click(
      within(machinePanel('Seated leg press')).getByRole('button', { name: copy.addSet }),
    );

    await waitFor(() => {
      expect(
        within(setCard(machinePanel('Seated leg press'), 2)).getByLabelText(copy.repsLabel),
      ).toHaveValue('9');
    });

    await destroyTestDatabase(view.db);
  });

  it('persists the draft the user is still holding when the workout is finished', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    // Changed and changed back, never blurred: the terminal flush owns what is on screen.
    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('12');
    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    await screen.findByText(copy.finishedTitle);
    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(10);
    await destroyTestDatabase(view.db);
  });
});

describe('a landing write and a newer local edit — a treadmill segment', () => {
  it('keeps a correction typed while the older write was still in flight', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const distance = within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel);

    await user.click(distance);
    await user.keyboard('3.05');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    const release = holdNextWrite(view.db);
    await user.clear(distance);
    await user.keyboard('3.5');
    await user.tab();

    await user.clear(distance);
    await user.keyboard('3.05');

    release();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3500);
    });
    expect(distance).toHaveValue('3.05');

    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    const reopened = await afterReopen(view, (db) => db.cardioSegments.toArray());
    expect(reopened.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(3050);
    await destroyTestDatabase(view.db);
  });

  it('keeps a correction blurred before the older write lands', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const distance = within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel);

    await user.click(distance);
    await user.keyboard('3.05');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    const release = holdNextWrite(view.db);
    await user.clear(distance);
    await user.keyboard('3.5');
    await user.tab();

    await user.clear(distance);
    await user.keyboard('3.05');
    await user.tab();

    release();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });
    // The same held window as the strength ordering above, and inside `act` for the same
    // reason: the queued write settles here.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    expect(distance).toHaveValue('3.05');

    const reopened = await afterReopen(view, (db) => db.cardioSegments.toArray());
    expect(reopened.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(3050);
    await destroyTestDatabase(view.db);
  });
});

/**
 * A lifecycle action and an edit made while it is still writing.
 *
 * Preserving a newer edit on screen -- everything above -- is only half an answer. `Mark
 * done` captures the draft and the revision it will store, and the row it writes comes back
 * **closed**: every field disabled, Save replaced by Reopen. An edit typed while that write
 * was outstanding was correctly kept in the draft and then had nowhere to go. The card said
 * `Done` and `Not saved yet` at once, and a reload rebuilt the completed row and lost the
 * entry. Skip and Remove had the same shape one step on: they flush, then close or destroy a
 * row a later edit was never written to.
 *
 * The repair is that such an action takes the draft with it. These tests hold the real write
 * open, so "while the action is outstanding" is a window the test controls, and they assert
 * every surface at once -- the field, the status, the save state, IndexedDB, and the row read
 * back from a reopened database -- because the defect was precisely that those disagreed.
 */
describe('an edit attempted while a closing action is outstanding', () => {
  it('never leaves a completed strength set holding a value it did not store', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    await user.click(reps);
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    const release = holdNextWrite(view.db);
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    // The card is closing, and says so by refusing input rather than swallowing it.
    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).toBeDisabled();
    });
    await user.type(within(card).getByLabelText(copy.repsLabel), '12');
    // Even dispatched straight at the element, past the disabled attribute.
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '12' } });
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('10');

    release();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.status).toBe('completed');
    });

    /*
     * Every surface agrees, which is the whole finding: no `Done` beside `Not saved yet`
     * over a number the database never received. The card is re-queried after the closed
     * status reaches the screen, because the stored row changing and the card re-rendering
     * are two different moments.
     */
    const closed = await waitFor(() => {
      const rendered = setCard(machinePanel('Seated leg press'), 1);
      expect(within(rendered).getByText(strings.setStatus.completed)).toBeInTheDocument();
      return rendered;
    });
    expect(within(closed).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect(closed.querySelector('.set__save-state')).toHaveTextContent(copy.saveStateSaved);

    const stored = (await storedSets(view.db))[0];
    expect(stored?.reps).toBe(10);
    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(10);
    await destroyTestDatabase(view.db);
  });

  it('never leaves a completed treadmill segment holding a value it did not store', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const distance = within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel);

    await user.click(distance);
    await user.keyboard('3.05');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    const release = holdNextWrite(view.db);
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.completeSegment }));

    await waitFor(() => {
      expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toBeDisabled();
    });
    fireEvent.change(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), {
      target: { value: '2.4' },
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');

    release();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.status).toBe('completed');
    });

    // Re-queried once the closed status has reached the screen, for the reason above.
    const closed = await waitFor(() => {
      const rendered = segmentCard(1);
      expect(within(rendered).getByText(strings.segmentStatus.completed)).toBeInTheDocument();
      return rendered;
    });
    expect(within(closed).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');
    expect(closed.querySelector('.segment__save-state')).toHaveTextContent(copy.saveStateSaved);

    expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    const reopened = await afterReopen(view, (db) => db.cardioSegments.toArray());
    expect(reopened.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(3050);
    await destroyTestDatabase(view.db);
  });

  /*
   * Skip is the two-step version: flush the draft, then hide the row. An edit arriving
   * between the two steps would be hidden although nothing had ever stored it, so the claim
   * has to span both steps rather than start after the flush.
   */
  it('never hides a strength set over an entry made after its flush', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    // Nothing recorded, because a set that holds recorded work refuses to be skipped at
    // all. What is under test here is the row that *can* be hidden.
    const release = holdNextWrite(view.db);
    await user.click(within(card).getByRole('button', { name: copy.skipSet }));

    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).toBeDisabled();
    });
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '12' } });
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('');

    release();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.status).toBe('skipped');
    });

    // The entry never became a draft, so the hidden row is not hiding anything.
    const closed = setCard(machinePanel('Seated leg press'), 1);
    expect(within(closed).getByLabelText(copy.repsLabel)).toHaveValue('');
    expect((await afterReopen(view, storedSets))[0]?.reps).toBeUndefined();
    await destroyTestDatabase(view.db);
  });

  it('never hides a treadmill segment over an entry made after its flush', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    const release = holdNextWrite(view.db);
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.skipSegment }));

    await waitFor(() => {
      expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toBeDisabled();
    });
    fireEvent.change(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), {
      target: { value: '2.4' },
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('');

    release();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.status).toBe('skipped');
    });

    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('');
    const reopened = await afterReopen(view, (db) => db.cardioSegments.toArray());
    expect(
      reopened.find((segment) => segment.position === 0)?.actualDistanceMeters,
    ).toBeUndefined();
    await destroyTestDatabase(view.db);
  });

  it('holds the draft while a removal runs, and destroys nothing it did not flush', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    const release = holdNextWrite(view.db);
    await user.click(within(card).getByRole('button', { name: copy.removeSet }));
    await user.click(await screen.findByRole('button', { name: copy.removeSetDialogConfirm }));

    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).toBeDisabled();
    });
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '12' } });
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('');

    release();
    await waitFor(async () => {
      expect(await storedSets(view.db)).toHaveLength(0);
    });
    expect(await afterReopen(view, storedSets)).toHaveLength(0);
    await destroyTestDatabase(view.db);
  });
});

describe('when a lifecycle action fails or never starts', () => {
  /*
   * A refusal has to give the card back. The repository will not destroy recorded work, so
   * this removal is refused on its merits -- and the fields must become editable again with
   * every value intact, or the refusal would have cost the user the row it was protecting.
   */
  it('unlocks editing and keeps the draft when a removal is refused', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');
    const reps = within(card).getByLabelText(copy.repsLabel);

    await user.click(reps);
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });

    await user.click(within(card).getByRole('button', { name: copy.removeSet }));
    await user.click(await screen.findByRole('button', { name: copy.removeSetDialogConfirm }));

    expect(await within(card).findByText(copy.removeSetBlockedTitle)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).not.toBeDisabled();
    });
    expect((await storedSets(view.db))[0]?.reps).toBe(10);

    // Editable again, and the edit reaches the database.
    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('12');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(12);
    });
    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(12);
    await destroyTestDatabase(view.db);
  });

  /*
   * The lock is for actions that end the card's editable life, and for nothing else. An
   * ordinary autosave must leave the form alone, or entering a workout would mean typing
   * into fields that grey out between every field.
   */
  it('leaves the fields editable while an ordinary save is in flight', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    const release = holdNextWrite(view.db);
    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();

    // The save is outstanding and the next field still accepts input.
    expect(within(card).getByLabelText(copy.loadLabel)).not.toBeDisabled();
    await user.click(within(card).getByLabelText(copy.loadLabel));
    await user.keyboard('60');
    await user.tab();

    release();
    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.reps).toBe(10);
      expect(stored?.loadValue).toBe(60);
    });
    // Both queued writes reload the page, so the card is only quiet once it says so.
    await waitFor(() => {
      expect(
        setCard(machinePanel('Seated leg press'), 1).querySelector('.set__save-state'),
      ).toHaveTextContent(copy.saveStateSaved);
    });
    await destroyTestDatabase(view.db);
  });

  /*
   * The contract the old `disabled={mutation.isPending}` broke, pinned here because this
   * repair is the one that would be tempted to restore it. Tapping `Mark done` while a field
   * still has focus fires that field's blur first, which starts a save -- and if the button
   * disabled itself on a pending write, React would re-render it disabled before the tap's
   * own click arrived and the tap would do nothing at all.
   */
  it('completes a set tapped while a field it just changed is still saving', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    // No blur of our own: the click on Mark done is what blurs the field.
    await user.click(within(card).getByRole('button', { name: copy.completeSet }));

    await waitFor(async () => {
      const stored = (await storedSets(view.db))[0];
      expect(stored?.status).toBe('completed');
      expect(stored?.reps).toBe(10);
    });
    expect((await afterReopen(view, storedSets))[0]?.reps).toBe(10);
    await destroyTestDatabase(view.db);
  });
});

/**
 * The workout closing, and the fields it is closing over.
 *
 * Every card above defends its own draft against its own writes. A terminal Finish or
 * Cancel is not one card's write, though: `flushAll` walks the registered cards one at a
 * time, and only when all of them have returned does the session itself get written. Each
 * card used to claim its draft for the length of its own `flush` and hand it straight back,
 * which left two windows a person can type into --
 *
 * 1. between one card's flush returning and the last card's flush finishing, and
 * 2. for the whole duration of `finishSession` or `cancelSession`.
 *
 * Anything entered in either window was visible, was owned by the ownership rule above, and
 * was then unmounted along with the session that closed over it. The regression appeared
 * exactly: save reps `10`, hold the finish transaction, confirm Finish, type `12` into the
 * still-enabled field, release -- and a reopened database returns `10`.
 *
 * So the claim belongs to the operation, not to the flush. These tests hold a real
 * read-write transaction open at each of those two points and assert, from outside React,
 * that every registered card is refusing edits: the field is disabled, a change dispatched
 * straight at the element is rejected, the session has not closed, and what the database
 * holds afterwards -- read back from a reopened database -- is what was last visible.
 */
describe('a session-terminal action and the cards it closes over', () => {
  it('keeps every card locked while a later card is still flushing', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    /*
     * Dispatched rather than typed, so nothing is blurred and nothing is saved: both cards
     * reach Finish holding an unwritten value, and `flushAll` therefore really does perform
     * two writes in sequence rather than skipping straight to the session.
     */
    fireEvent.change(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), {
      target: { value: '3.05' },
    });
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '10' } });

    // Holds the *second* flush, so by definition one card has already been made durable.
    const release = holdNextWrite(view.db, 1);
    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    // The card whose flush already returned is locked too, which is the whole finding.
    await waitFor(() => {
      expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toBeDisabled();
    });
    expect(within(card).getByLabelText(copy.repsLabel)).toBeDisabled();
    fireEvent.change(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), {
      target: { value: '9.99' },
    });
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '12' } });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect((await storedSessions(view.db))[0]?.status).toBe('in_progress');

    /*
     * Read off the screen rather than written down as a constant. The invariant is not
     * "the database ends at 10"; it is "the database ends at whatever the user was last
     * looking at", and only a value taken from the element itself can state that. Without
     * the session-wide claim these read `9.99` and `12` while the database keeps `3.05`
     * and `10`, which is the loss.
     */
    const lastVisibleDistance = visibleValue(segmentCard(1), copy.actualDistanceLabel);
    const lastVisibleReps = visibleValue(card, copy.repsLabel);

    release();
    expect(await screen.findByText(copy.finishedTitle)).toBeInTheDocument();

    // Nothing newer was ever accepted, so what closed is exactly what was on screen.
    expect((await storedSets(view.db))[0]?.reps).toBe(Number(lastVisibleReps));
    expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(
      Math.round(Number(lastVisibleDistance) * 1000),
    );
    const reopened = await afterReopen(view, async (db) => ({
      sessions: await storedSessions(db),
      sets: await storedSets(db),
      segments: await db.cardioSegments.toArray(),
    }));
    expect(reopened.sessions[0]?.status).toBe('completed');
    expect(reopened.sets[0]?.reps).toBe(Number(lastVisibleReps));
    expect(reopened.segments.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(
      Math.round(Number(lastVisibleDistance) * 1000),
    );
    await destroyTestDatabase(view.db);
  });

  it('keeps every card locked while the finishing write is outstanding', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    // Saved and landed, so every draft is clean and the held write is the session itself.
    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    await saveStateSettled(card);
    await user.click(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel));
    await user.keyboard('3.05');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });
    await saveStateSettled(segmentCard(1));

    // Nothing is outstanding, so the write this holds is the session write itself.
    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    // Strength and cardio alike, including the segment nobody touched.
    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).toBeDisabled();
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toBeDisabled();
    expect(within(segmentCard(2)).getByLabelText(copy.actualDistanceLabel)).toBeDisabled();

    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '12' } });
    fireEvent.change(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), {
      target: { value: '2.4' },
    });
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');
    expect((await storedSessions(view.db))[0]?.status).toBe('in_progress');

    // The original regression case: what the reopened database returns is compared with
    // what the field was showing when the workout closed, not with a remembered number.
    const lastVisibleReps = visibleValue(card, copy.repsLabel);
    const lastVisibleDistance = visibleValue(segmentCard(1), copy.actualDistanceLabel);

    release();
    expect(await screen.findByText(copy.finishedTitle)).toBeInTheDocument();

    const reopened = await afterReopen(view, async (db) => ({
      sessions: await storedSessions(db),
      sets: await storedSets(db),
      segments: await db.cardioSegments.toArray(),
    }));
    expect(reopened.sessions).toHaveLength(1);
    expect(reopened.sessions[0]?.status).toBe('completed');
    expect(reopened.sets[0]?.reps).toBe(Number(lastVisibleReps));
    expect(reopened.segments.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(
      Math.round(Number(lastVisibleDistance) * 1000),
    );
    await destroyTestDatabase(view.db);
  });

  it('keeps every card locked while the cancelling write is outstanding', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    await saveStateSettled(card);
    await user.click(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel));
    await user.keyboard('3.05');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });
    await saveStateSettled(segmentCard(1));

    // Nothing is outstanding, so the write this holds is the session write itself.
    const release = holdNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));

    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).toBeDisabled();
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toBeDisabled();
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: '12' } });
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('10');
    expect((await storedSessions(view.db))[0]?.status).toBe('in_progress');

    const lastVisibleReps = visibleValue(card, copy.repsLabel);

    release();
    expect(await screen.findByText(copy.cancelledTitle)).toBeInTheDocument();

    // Cancelling keeps what was recorded, so the values have to survive it exactly.
    const reopened = await afterReopen(view, async (db) => ({
      sessions: await storedSessions(db),
      sets: await storedSets(db),
      segments: await db.cardioSegments.toArray(),
    }));
    expect(reopened.sessions[0]?.status).toBe('cancelled');
    expect(reopened.sets[0]?.reps).toBe(Number(lastVisibleReps));
    expect(reopened.segments.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(
      3050,
    );
    await destroyTestDatabase(view.db);
  });
});

/**
 * The other half of the claim: everything that leaves the workout open gives it back.
 *
 * A lock whose release depends on the happy path is worse than no lock, because a refused
 * flush or a refused session write would leave the user looking at a workout that is still
 * running and a page that will not accept another keystroke. Both failures are provoked
 * here against the real database, and both end with the cards editable, the drafts intact,
 * and a retry that closes the session exactly once.
 */
describe('when a session-terminal action fails', () => {
  it('gives every card back when a flush is refused, and finishes on the retry', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    // A draft that cannot be parsed, so the barrier refuses before anything terminal runs.
    fireEvent.change(within(card).getByLabelText(copy.repsLabel), { target: { value: 'abc' } });

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    expect(await screen.findByText(copy.draftBlockedTitle)).toBeInTheDocument();
    expect((await storedSessions(view.db))[0]?.status).toBe('in_progress');

    // Every card, not only the one that refused: the claim was session-wide.
    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).not.toBeDisabled();
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).not.toBeDisabled();
    expect(within(card).getByLabelText(copy.repsLabel)).toHaveValue('abc');

    // Editable and durable again, on both kinds of card.
    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('12');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(12);
    });
    await user.click(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel));
    await user.keyboard('3.05');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));
    expect(await screen.findByText(copy.finishedTitle)).toBeInTheDocument();

    const reopened = await afterReopen(view, async (db) => ({
      sessions: await storedSessions(db),
      sets: await storedSets(db),
      segments: await db.cardioSegments.toArray(),
    }));
    // One session, one set: the refusal and the retry did not duplicate anything.
    expect(reopened.sessions).toHaveLength(1);
    expect(reopened.sessions[0]?.status).toBe('completed');
    expect(reopened.sets).toHaveLength(1);
    expect(reopened.sets[0]?.reps).toBe(12);
    expect(reopened.segments.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(
      3050,
    );
    await destroyTestDatabase(view.db);
  });

  it('gives the cards back when the finishing write fails, and finishes once on the retry', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    await saveStateSettled(card);

    // Clean drafts, so the write that is refused is the session write itself.
    failNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    expect(await screen.findByText(copy.finishErrorTitle)).toBeInTheDocument();
    expect((await storedSessions(view.db))[0]?.status).toBe('in_progress');

    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).not.toBeDisabled();
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).not.toBeDisabled();

    // The correction the user makes after the failure has to be the one that is kept.
    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('12');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(12);
    });

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));
    expect(await screen.findByText(copy.finishedTitle)).toBeInTheDocument();

    const reopened = await afterReopen(view, async (db) => ({
      sessions: await storedSessions(db),
      sets: await storedSets(db),
    }));
    expect(reopened.sessions).toHaveLength(1);
    expect(reopened.sessions[0]?.status).toBe('completed');
    // Exactly one terminal action: the refused attempt left no timestamp of its own.
    expect(reopened.sessions[0]?.completedAt).toBeDefined();
    expect(reopened.sessions[0]?.cancelledAt).toBeUndefined();
    expect(reopened.sets[0]?.reps).toBe(12);
    await destroyTestDatabase(view.db);
  });

  it('gives the cards back when the cancelling write fails, and cancels on the retry', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = await addSetTo(user, 'Seated leg press');

    await user.click(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('10');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(10);
    });
    await saveStateSettled(card);

    failNextWrite(view.db);
    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));

    expect(await screen.findByText(copy.cancelErrorTitle)).toBeInTheDocument();
    expect((await storedSessions(view.db))[0]?.status).toBe('in_progress');

    await waitFor(() => {
      expect(within(card).getByLabelText(copy.repsLabel)).not.toBeDisabled();
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).not.toBeDisabled();

    await user.clear(within(card).getByLabelText(copy.repsLabel));
    await user.keyboard('12');
    await user.tab();
    await waitFor(async () => {
      expect((await storedSets(view.db))[0]?.reps).toBe(12);
    });

    await user.click(screen.getByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));
    expect(await screen.findByText(copy.cancelledTitle)).toBeInTheDocument();

    const reopened = await afterReopen(view, async (db) => ({
      sessions: await storedSessions(db),
      sets: await storedSets(db),
    }));
    expect(reopened.sessions).toHaveLength(1);
    expect(reopened.sessions[0]?.status).toBe('cancelled');
    expect(reopened.sessions[0]?.completedAt).toBeUndefined();
    // Cancelling keeps recorded work, including the correction made after the failure.
    expect(reopened.sets[0]?.reps).toBe(12);
    await destroyTestDatabase(view.db);
  });
});
