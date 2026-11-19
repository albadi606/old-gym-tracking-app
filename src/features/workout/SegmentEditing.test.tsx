import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
 * Recording what the treadmill showed.
 *
 * These tests exist to hold one line: the target and the recording are different data,
 * and typing into one must never reach the other. They also pin the draft contract --
 * what is typed is not saved until it is written through, an invalid entry stays a draft,
 * and a failed write leaves the typed values alone.
 */

const START = '2026-09-04T05:00:00.000Z';
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

async function renderRunningWorkout(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({
    route: ROUTE_PATHS.workout,
    children: routes(),
    seed: startTemplateSession,
  });
  await screen.findByRole('heading', { name: 'Treadmill' });
  return view;
}

/**
 * The stored segment at a given order, read without an index.
 *
 * `position` is only indexed as part of `[sessionActivityId+position]`, so a test must
 * not query it on its own.
 */
async function storedSegment(
  db: GymTrackerDatabase,
  position: number,
): Promise<CardioSegment | undefined> {
  const all = await db.cardioSegments.toArray();
  return all.sort((a, b) => a.position - b.position)[position];
}

/** The card for one segment, so an assertion cannot accidentally read its neighbour. */
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

describe('the target and the recording are separate', () => {
  it('shows the target beside empty fields for what the treadmill showed', async () => {
    const view = await renderRunningWorkout();
    const card = segmentCard(2);

    // The plan.
    expect(within(card).getByText('1.5 km')).toBeInTheDocument();
    expect(within(card).getByText('6 — unit not confirmed')).toBeInTheDocument();
    // The recording, still empty.
    expect(within(card).getByLabelText(copy.actualDistanceLabel)).toHaveValue('');
    expect(within(card).getByLabelText(copy.actualInclineLabel)).toHaveValue('');
    expect(within(card).getByLabelText(copy.actualInclineTypeLabel)).toHaveValue('unknown');

    await destroyTestDatabase(view.db);
  });

  it('records an actual incline without disturbing the planned 16', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(2);

    await user.type(within(card).getByLabelText(copy.actualInclineLabel), '12');
    await user.selectOptions(within(card).getByLabelText(copy.actualInclineTypeLabel), 'percent');
    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 1);
      expect(stored?.actualInclineValue).toBe(12);
    });

    const stored = await storedSegment(view.db, 1);
    expect(stored?.actualInclineType).toBe('percent');
    // The target the user set is untouched, which is the entire point of the split pair.
    expect(stored?.plannedInclineValue).toBe(6);
    expect(stored?.plannedInclineType).toBe('unknown');

    await destroyTestDatabase(view.db);
  });

  it('writes a recorded distance through to the database on blur', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3.05');
    // Moving to the next field commits the change: nothing is left only on screen.
    await user.tab();

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.actualDistanceMeters).toBe(3050);
    });
    const stored = await storedSegment(view.db, 0);
    // Saving values is not the same as declaring the segment done.
    expect(stored?.status).toBe('planned');
    expect(stored?.plannedDistanceMeters).toBe(2400);

    await destroyTestDatabase(view.db);
  });
});

describe('the draft contract', () => {
  it('says a change is not saved yet, then says it is saved', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    expect(within(card).getByText(copy.saveStateSaved)).toBeInTheDocument();

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3');
    expect(within(card).getByText(copy.saveStateUnsaved)).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));
    await waitFor(() => {
      expect(within(segmentCard(1)).getByText(copy.saveStateSaved)).toBeInTheDocument();
    });

    await destroyTestDatabase(view.db);
  });

  it('keeps an invalid entry as a draft and stores nothing', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), 'three km');
    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));

    expect(await within(segmentCard(1)).findByText(en.validation.number)).toBeInTheDocument();
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('three km');
    // A half-typed number never replaces the last durable value.
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBeUndefined();

    await destroyTestDatabase(view.db);
  });

  it('clears a measured incline through the form, unit and all', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualInclineLabel), '12');
    await user.selectOptions(within(card).getByLabelText(copy.actualInclineTypeLabel), 'percent');
    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));
    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.actualInclineValue).toBe(12);
      expect(stored?.actualInclineType).toBe('percent');
    });

    // Emptying the value is the whole gesture: the user never touches the unit again.
    await user.clear(within(segmentCard(1)).getByLabelText(copy.actualInclineLabel));
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.actualInclineValue).toBeUndefined();
      // Never a unit with nothing to measure.
      expect(stored?.actualInclineType).toBe('unknown');
    });
    expect(within(segmentCard(1)).getByLabelText(copy.actualInclineTypeLabel)).toHaveValue(
      'unknown',
    );

    await destroyTestDatabase(view.db);
  });

  it('clears a level incline the same way, without a blur', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualInclineLabel), '8');
    await user.selectOptions(within(card).getByLabelText(copy.actualInclineTypeLabel), 'level');
    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));
    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualInclineValue).toBe(8);
    });

    const field = within(segmentCard(1)).getByLabelText(copy.actualInclineLabel);
    fireEvent.change(field, { target: { value: '' } });
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.actualInclineValue).toBeUndefined();
      expect(stored?.actualInclineType).toBe('unknown');
    });

    await destroyTestDatabase(view.db);
  });

  it('preserves what was typed and offers a retry when the write fails', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    vi.spyOn(view.db.cardioSegments, 'put').mockRejectedValueOnce(new Error('database busy'));

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));

    expect(await within(segmentCard(1)).findByText(copy.saveFailedBody)).toBeInTheDocument();
    // Nothing the user typed was lost, and the failure is not mistaken for a save.
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBeUndefined();

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.retry }));
    await waitFor(async () => {
      const retried = await storedSegment(view.db, 0);
      expect(retried?.actualDistanceMeters).toBe(3050);
    });

    await destroyTestDatabase(view.db);
  });
});

describe('the secondary fields', () => {
  it('are collapsed by default but still reachable and saveable', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    // The four numbers a treadmill shows are visible without opening anything.
    expect(within(card).getByLabelText(copy.actualDistanceLabel)).toBeVisible();
    expect(within(card).getByLabelText(copy.actualDurationLabel)).toBeVisible();
    expect(within(card).getByLabelText(copy.actualSpeedLabel)).toBeVisible();
    expect(within(card).getByLabelText(copy.actualInclineLabel)).toBeVisible();

    // Heart rate and effort are present in the document but folded away.
    const details = within(card).getByText(copy.moreDetail).closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');

    await user.click(within(card).getByText(copy.moreDetail));
    await user.type(within(card).getByLabelText(copy.averageHeartRateLabel), '150');
    await user.type(within(card).getByLabelText(copy.maxHeartRateLabel), '170');
    await user.type(within(card).getByLabelText(copy.rpeLabel), '7.5');
    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.averageHeartRateBpm).toBe(150);
    });
    const stored = await storedSegment(view.db, 0);
    expect(stored?.maxHeartRateBpm).toBe(170);
    expect(stored?.rpe).toBe(7.5);

    await destroyTestDatabase(view.db);
  });
});

describe('completing a segment', () => {
  it('refuses a completion with nothing recorded, and explains why', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.completeSegment }));

    expect(
      await within(segmentCard(1)).findByText(copy.completeNeedsWorkError),
    ).toBeInTheDocument();
    const stored = await storedSegment(view.db, 0);
    expect(stored?.status).toBe('planned');

    await destroyTestDatabase(view.db);
  });

  it('writes the final values and the completion together', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.type(within(card).getByLabelText(copy.actualDurationLabel), '20:50');
    await user.click(within(card).getByRole('button', { name: copy.completeSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.status).toBe('completed');
    });

    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);
    expect(stored?.actualDurationSeconds).toBe(1250);
    expect(stored?.completedAt).toBe(START);

    // The card now reports the state in words, not by colour. It re-renders from the
    // reload that follows the write, so this waits rather than assuming.
    await waitFor(() => {
      expect(within(segmentCard(1)).getByText(en.segmentStatus.completed)).toBeInTheDocument();
    });

    await destroyTestDatabase(view.db);
  });

  it('completes once when Mark done is double-tapped', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3.05');
    const button = within(card).getByRole('button', { name: copy.completeSegment });

    const put = vi.spyOn(view.db.cardioSegments, 'put');
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.status).toBe('completed');
    });
    expect(put).toHaveBeenCalledTimes(1);
    await expect(view.db.cardioSegments.count()).resolves.toBe(2);

    await destroyTestDatabase(view.db);
  });

  it('reopens a completed segment without discarding its numbers', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(card).getByRole('button', { name: copy.completeSegment }));

    const reopen = await within(segmentCard(1)).findByRole('button', {
      name: copy.reopenSegment,
    });
    await user.click(reopen);

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.status).toBe('planned');
    });
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);
    expect(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel)).toHaveValue('3.05');

    await destroyTestDatabase(view.db);
  });
});

describe('adding, removing, and reordering', () => {
  it('appends a segment at the end of the activity', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.click(screen.getByRole('button', { name: copy.addSegment }));

    await waitFor(async () => {
      await expect(view.db.cardioSegments.count()).resolves.toBe(3);
    });
    const positions = (await view.db.cardioSegments.toArray())
      .map((segment) => segment.position)
      .sort();
    expect(positions).toEqual([0, 1, 2]);

    await destroyTestDatabase(view.db);
  });

  it('swaps two segments and leaves unique positions', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.moveDown }));

    await waitFor(() => {
      // The walk target, previously second, is now the first card.
      expect(within(segmentCard(1)).getByText('1.5 km')).toBeInTheDocument();
    });
    const stored = await view.db.cardioSegments.toArray();
    expect(stored.map((segment) => segment.position).sort()).toEqual([0, 1]);
    expect(stored.find((segment) => segment.position === 0)?.mode).toBe('walk');

    await destroyTestDatabase(view.db);
  });

  it('refuses to remove a segment holding recorded numbers, and says so', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(card).getByRole('button', { name: copy.saveSegment }));
    await waitFor(() => {
      expect(within(segmentCard(1)).getByText(copy.saveStateSaved)).toBeInTheDocument();
    });

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.removeSegment }));
    await user.click(await screen.findByRole('button', { name: copy.removeDialogConfirm }));

    expect(await screen.findByText(copy.removeBlockedTitle)).toBeInTheDocument();
    // The row is still there with its numbers intact.
    await expect(view.db.cardioSegments.count()).resolves.toBe(2);
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualDistanceMeters).toBe(3050);

    await destroyTestDatabase(view.db);
  });

  it('removes an empty segment after an explicit confirmation', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.removeSegment }));
    const dialog = await screen.findByRole('dialog');
    // The safe choice holds focus.
    expect(within(dialog).getByRole('button', { name: copy.removeDialogCancel })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: copy.removeDialogConfirm }));

    await waitFor(async () => {
      await expect(view.db.cardioSegments.count()).resolves.toBe(1);
    });
    const remaining = await view.db.cardioSegments.toArray();
    expect(remaining[0]?.position).toBe(0);
    expect(remaining[0]?.mode).toBe('walk');

    await destroyTestDatabase(view.db);
  });

  it('marks a planned segment skipped, keeping its target', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.skipSegment }));

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.status).toBe('skipped');
    });
    const stored = await storedSegment(view.db, 0);
    expect(stored?.plannedDistanceMeters).toBe(2400);

    await destroyTestDatabase(view.db);
  });
});

describe('derived values are offered, never substituted', () => {
  it('shows the implied average speed beside the speed that was displayed', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    await user.type(within(card).getByLabelText(copy.actualDistanceLabel), '3');
    await user.type(within(card).getByLabelText(copy.actualDurationLabel), '20:00');
    await user.type(within(card).getByLabelText(copy.actualSpeedLabel), '8.6');
    await user.click(within(card).getByRole('button', { name: copy.completeSegment }));

    await waitFor(() => {
      // 3 km in 20 minutes is 9 km/h, which is not the 8.6 the treadmill displayed.
      expect(within(segmentCard(1)).getByText(/Works out at 9 km\/h/)).toBeInTheDocument();
    });
    const stored = await storedSegment(view.db, 0);
    expect(stored?.actualSpeedKph).toBe(8.6);

    await destroyTestDatabase(view.db);
  });
});

/**
 * The same repair, proved on the other card.
 *
 * Both cards share `useCardWrites` because both had the same defect: a second field blur
 * carries a later revision of the draft, and dropping it as a duplicate lost a value the
 * user had entered and the card had shown as accepted.
 */
describe('two fields blurred while the first save is still running', () => {
  /** Holds the next read-write transaction open. Reads pass through untouched. */
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

  it('stores both values, newest last', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const card = segmentCard(1);

    const release = holdFirstWrite(view.db);

    await user.click(within(card).getByLabelText(copy.actualDistanceLabel));
    await user.keyboard('3.05');
    await user.tab();

    await user.click(within(card).getByLabelText(copy.actualDurationLabel));
    await user.keyboard('20:50');
    await user.tab();

    release();

    await waitFor(async () => {
      const stored = await storedSegment(view.db, 0);
      expect(stored?.actualDistanceMeters).toBe(3050);
      expect(stored?.actualDurationSeconds).toBe(1250);
    });

    await destroyTestDatabase(view.db);
  });

  it('still writes once when a blur and the Save button ask for the same draft', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();

    // Held, so the two requests really do overlap. See the strength card's twin of this.
    const release = holdFirstWrite(view.db);
    const put = vi.spyOn(view.db.cardioSegments, 'put');

    await user.type(within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(within(segmentCard(1)).getByRole('button', { name: copy.saveSegment }));
    release();

    await waitFor(async () => {
      expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);
    });
    expect(put).toHaveBeenCalledTimes(1);
    put.mockRestore();

    await destroyTestDatabase(view.db);
  });
});

/**
 * The stale-write race, on the segment card.
 *
 * Both cards consume the same coordinator, so both inherited the defect: a save matching
 * the write in flight was dropped even when a *different* revision was already queued, so
 * changing a value and changing it back let the value in between win.
 */
describe('changing a field and changing it back while the first save is held', () => {
  /** Holds the next read-write transaction open. Reads pass through untouched. */
  function holdWrite(db: GymTrackerDatabase): () => void {
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

  it('stores what the user went back to, not the revision queued in between', async () => {
    const user = userEvent.setup();
    const view = await renderRunningWorkout();
    const distance = within(segmentCard(1)).getByLabelText(copy.actualDistanceLabel);

    const release = holdWrite(view.db);

    await user.click(distance);
    await user.keyboard('3.05');
    await user.tab();

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
    // Held for a moment: the defect was a later write arriving and changing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await storedSegment(view.db, 0))?.actualDistanceMeters).toBe(3050);

    // And the database on its own holds it, after being closed and opened again.
    view.unmount();
    view.db.close();
    await view.db.open();
    const reopened = await view.db.cardioSegments.toArray();
    expect(reopened.find((segment) => segment.position === 0)?.actualDistanceMeters).toBe(3050);

    await destroyTestDatabase(view.db);
  });
});
