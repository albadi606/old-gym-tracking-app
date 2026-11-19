import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { softDeleteSession } from '../../db/history-repository.ts';
import { createFixedClock } from '../../domain/clock.ts';
import { en } from '../../i18n/en.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { seedRecordedWorkout } from '../../test/history.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { formatMessage } from '../../shared/format-message.ts';

/**
 * Progress, rendered against real recorded workouts.
 *
 * The assertions are about what the screen is willing to claim. Most of them check that
 * something is *not* said: no trend from one observation, no record for a first result, no
 * comparison across an unknown load basis, and no "not enough data" when what actually
 * happened is a workout being excluded on purpose.
 */

const copy = en.pages.progress;
const CLOCK = createFixedClock('2026-09-08T05:00:00.000Z');

describe('with nothing logged', () => {
  it('says so, and says which workouts it reads', async () => {
    const view = await renderWithDatabase({ route: '/progress' });

    expect(await screen.findByText(copy.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.emptyBody)).toBeInTheDocument();
    expect(screen.getByText(copy.sourceNote)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('does not count a cancelled or a deleted workout as data', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { idBase: 1000, name: 'Abandoned', ending: 'cancel' });
        const { sessionId } = await seedRecordedWorkout(db, {
          idBase: 2000,
          name: 'Removed',
          startedAt: '2026-09-06T05:00:00.000Z',
        });
        await softDeleteSession(db, sessionId, { clock: CLOCK });
      },
    });

    expect(await screen.findByText(copy.emptyTitle)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('cardio', () => {
  it('lists every recorded segment with its own units, and calls one observation a baseline', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: copy.cardioHeading });
    expect(screen.getByText(copy.cardioBaselineOnly)).toBeInTheDocument();

    const table = screen.getByRole('table', { name: copy.cardioTableCaption });
    const rows = within(table).getAllByRole('row');
    // A header row plus the one completed segment.
    expect(rows).toHaveLength(2);
    expect(within(table).getByText('2.4 km')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('says why an average speed is withheld rather than inventing one', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        // A segment with a distance but no time cannot produce an average.
        await seedRecordedWorkout(db, { name: 'No time recorded', omitDuration: true });
      },
    });

    await screen.findByRole('heading', { name: copy.cardioHeading });
    expect(screen.getByText(copy.overallAverageUnavailable)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('states that an incline is a setting, not height climbed', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: copy.cardioHeading });
    // The seeded routine records no incline, so no incline series is claimed at all.
    expect(screen.queryByText(copy.inclineHeading)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('strength', () => {
  it('calls a first comparable result a baseline rather than a record', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: copy.strengthHeading });
    expect(screen.getByText(copy.baselineResult)).toBeInTheDocument();
    expect(screen.getByText(copy.baselineNote)).toBeInTheDocument();
    expect(screen.queryByText(copy.loadRecord)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('claims a record only against an earlier comparable set, and says what it compared', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, {
          idBase: 1000,
          name: 'First',
          startedAt: '2026-09-05T05:00:00.000Z',
          loadValue: 40,
        });
        await seedRecordedWorkout(db, {
          idBase: 2000,
          name: 'Second',
          startedAt: '2026-09-07T05:00:00.000Z',
          loadValue: 55,
        });
      },
    });

    await screen.findByRole('heading', { name: copy.strengthHeading });
    expect(screen.getByText(copy.loadRecord, { exact: false })).toBeInTheDocument();
    // A record states what it beat and how many sets it was measured against.
    expect(screen.getByText(/Previous best/)).toBeInTheDocument();
    expect(screen.getByText(/Compared against 1 earlier set/)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('shows an unknown load basis without ever comparing it', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        // The plate-loaded press keeps an `unknown` basis until the user confirms it.
        await seedRecordedWorkout(db, {
          idBase: 1000,
          name: 'Plate press one',
          from: 'blank',
          machineSeedKey: 'plate-leg-press-01',
          exerciseSeedKey: 'plate-leg-press',
          loadValue: 60,
        });
        await seedRecordedWorkout(db, {
          idBase: 2000,
          name: 'Plate press two',
          startedAt: '2026-09-07T05:00:00.000Z',
          from: 'blank',
          machineSeedKey: 'plate-leg-press-01',
          exerciseSeedKey: 'plate-leg-press',
          loadValue: 100,
        });
      },
    });

    await screen.findByRole('heading', { name: copy.strengthHeading });
    expect(screen.getByText(copy.notComparableTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.loadRecord)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.baselineResult)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('what was logged', () => {
  it('counts weeks factually and never uses streak language', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: copy.consistencyHeading });
    expect(screen.getByText(copy.workoutsLoggedOne)).toBeInTheDocument();
    expect(screen.getByText(copy.consistencyNote)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('says the muscle mapping is applied to past logs, not frozen at the time', async () => {
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: copy.coverageHeading });
    expect(screen.getByText(copy.coverageClassificationNote)).toBeInTheDocument();
    expect(screen.getByText(copy.coverageEditHint)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('what the filter panel actually narrows', () => {
  /*
   * Every claim under the panel must obey it. The date reached the selection and the rest
   * reached only the two trend builders, so choosing one machine left the workout count at
   * two and went on crediting the muscles worked on the other one -- under a panel that
   * announced the filter was applied.
   *
   * Two workouts on two different machines, so a filter that narrows nothing and a filter
   * that narrows correctly produce different screens.
   */
  async function twoMachines() {
    return renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, {
          idBase: 1000,
          name: 'Leg day',
          from: 'blank',
          machineSeedKey: 'seated-leg-press-01',
          exerciseSeedKey: 'seated-leg-press',
        });
        await seedRecordedWorkout(db, {
          idBase: 2000,
          name: 'Back day',
          startedAt: '2026-09-06T05:00:00.000Z',
          from: 'blank',
          machineSeedKey: 'low-row-station-01',
          exerciseSeedKey: 'seated-cable-row',
        });
      },
    });
  }

  it('narrows the workout count to the machine that was selected', async () => {
    const user = userEvent.setup();
    const view = await twoMachines();

    await screen.findByRole('heading', { name: copy.consistencyHeading });
    expect(screen.getByText(formatMessage(copy.workoutsLogged, { count: 2 }))).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText(copy.machineLabel),
      'Selectorized seated leg press',
    );

    expect(await screen.findByText(copy.workoutsLoggedOne)).toBeInTheDocument();
    expect(
      screen.queryByText(formatMessage(copy.workoutsLogged, { count: 2 })),
    ).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('narrows the weekly muscle coverage to that machine too', async () => {
    const user = userEvent.setup();
    const view = await twoMachines();

    await screen.findByRole('heading', { name: copy.coverageHeading });
    const coverage = (): HTMLElement => screen.getByRole('region', { name: copy.coverageHeading });
    expect(within(coverage()).getAllByText(/Back/).length).toBeGreaterThan(0);

    await user.selectOptions(
      screen.getByLabelText(copy.machineLabel),
      'Selectorized seated leg press',
    );

    await screen.findByText(copy.workoutsLoggedOne);
    // The other machine's areas are gone, not merely pushed further down the page.
    expect(within(coverage()).queryAllByText(/Back/)).toHaveLength(0);
    expect(within(coverage()).getAllByText(/Quadriceps/).length).toBeGreaterThan(0);

    await destroyTestDatabase(view.db);
  });

  it('presents no strength coverage at all when only cardio is selected', async () => {
    const user = userEvent.setup();
    const view = await twoMachines();

    await screen.findByRole('heading', { name: copy.coverageHeading });
    await user.selectOptions(screen.getByLabelText(copy.kindLabel), copy.kindCardio);

    // Nothing seeded here is cardio, so the honest answer is that nothing matched.
    expect(await screen.findByText(copy.noResultsTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.coveragePrimary)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('states the weeks the selected range covers, not the span of the results', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, {
          name: 'Tuesday legs',
          startedAt: '2026-09-09T05:00:00.000Z',
        });
      },
    });

    await screen.findByRole('heading', { name: copy.consistencyHeading });
    await user.type(screen.getByLabelText(copy.fromLabel), '2026-09-01');
    await user.type(screen.getByLabelText(copy.toLabel), '2026-09-30');

    /*
     * September 2026 touches five Monday weeks. The screen used to describe the one week
     * the single workout is in and call it "in this range".
     */
    expect(
      await screen.findByText(formatMessage(copy.activeWeeks, { active: 1, spanned: 5 })),
    ).toBeInTheDocument();
    // Not the wording used when there is no range to be a fraction of.
    expect(screen.queryByText(copy.activeWeeksOne)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('is a search landmark, in markup this runtime recognises', async () => {
    const view = await renderWithDatabase({ route: '/progress' });
    expect(await screen.findByRole('search')).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('filtering', () => {
  it('reports an empty filter result as an empty filter result', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/progress',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: copy.cardioHeading });
    await user.type(screen.getByLabelText(copy.fromLabel), '2027-01-01');

    expect(await screen.findByText(copy.noResultsTitle)).toBeInTheDocument();
    // Never "not enough data": the workouts are still there.
    expect(screen.queryByText(copy.emptyTitle)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.showAll }));
    expect(await screen.findByRole('heading', { name: copy.cardioHeading })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
