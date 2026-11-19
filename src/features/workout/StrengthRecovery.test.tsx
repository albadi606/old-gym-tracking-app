import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { addStrengthSet, completeStrengthSet } from '../../db/strength-repository.ts';
import {
  finishSession,
  getSessionDetail,
  getTemplateBySeedKey,
  startSessionFromTemplate,
} from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * What the screen does when a read fails.
 *
 * `useDatabaseQuery` deliberately reports three different things -- loading, ready, and
 * error -- plus a `reload`. An earlier implementation collapsed all of that into "undefined",
 * which produced three separate untruths: a settings failure became an endless "Loading"
 * with Add a machine disabled and no way out; a catalog failure became "No machines in
 * your catalog", sending the user to add machines he already has; and a failed read of the
 * comparison history became "no previous result", which is one step from decorating an
 * ordinary set with "first finished set on this setup" over history nobody could read.
 *
 * The rule these tests hold: **an unread answer is never reported as an answer.** Every
 * failure names itself, offers a retry, and the retry produces the real thing.
 */

const START = '2026-09-05T05:00:00.000Z';
const EARLIER = '2026-08-20T05:00:00.000Z';
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

async function startTemplateSession(
  db: GymTrackerDatabase,
  at: string,
  idSeed: number,
): Promise<string> {
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  const detail = await startSessionFromTemplate(db, template?.id ?? '', {
    clock: createFixedClock(at),
    ids: createSequentialIdProvider(idSeed),
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
  });
  return detail.session.id;
}

/**
 * A finished workout holding one completed set, so "there is history" is a fact of the
 * database rather than an assumption of the test.
 */
async function seedHistory(db: GymTrackerDatabase): Promise<void> {
  const sessionId = await startTemplateSession(db, EARLIER, 3000);
  const detail = await getSessionDetail(db, sessionId);
  const press = detail?.activities.find((activity) => activity.displayName === 'Seated leg press');
  const set = await addStrengthSet(db, press?.id ?? '', { clock: createFixedClock(EARLIER) });
  await completeStrengthSet(
    db,
    set.id,
    { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
    { clock: createFixedClock(EARLIER) },
  );
  await finishSession(db, sessionId, { clock: createFixedClock(EARLIER) });
}

async function render(
  seed: (db: GymTrackerDatabase) => Promise<void>,
): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  return renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes(), seed });
}

describe('preferences that cannot be read', () => {
  it('says so, offers a retry, and shows the real machines once it succeeds', async () => {
    const user = userEvent.setup();
    let settings: { mockRestore: () => void } | undefined;
    const view = await render(async (db) => {
      await startTemplateSession(db, START, 5000);
      settings = vi.spyOn(db.settings, 'get').mockRejectedValue(new Error('database busy'));
    });

    // Named, not an endless wait.
    expect(await screen.findByText(copy.settingsUnavailableTitle)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Seated leg press' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.addStrengthActivity })).toBeDisabled();

    settings?.mockRestore();
    await user.click(screen.getAllByRole('button', { name: copy.retry })[0] as HTMLElement);

    expect(await screen.findByRole('heading', { name: 'Seated leg press' })).toBeInTheDocument();
    expect(screen.queryByText(copy.settingsUnavailableTitle)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.addStrengthActivity })).toBeEnabled();

    await destroyTestDatabase(view.db);
  });

  it('names a missing singleton as the integrity problem it is', async () => {
    const view = await render(async (db) => {
      await startTemplateSession(db, START, 5000);
      vi.spyOn(db.settings, 'get').mockResolvedValue(undefined);
    });

    // A record that is absent will never arrive, so there is nothing to retry.
    expect(await screen.findByText(copy.settingsMissingTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.settingsUnavailableTitle)).not.toBeInTheDocument();

    vi.restoreAllMocks();
    await destroyTestDatabase(view.db);
  });
});

describe('a comparison history that cannot be read', () => {
  it('is never reported as an empty history, and never as a first result', async () => {
    const user = userEvent.setup();
    let machines: { mockRestore: () => void } | undefined;
    const view = await render(async (db) => {
      await seedHistory(db);
      const sessionId = await startTemplateSession(db, START, 5000);
      const detail = await getSessionDetail(db, sessionId);
      const press = detail?.activities.find(
        (activity) => activity.displayName === 'Seated leg press',
      );
      await addStrengthSet(db, press?.id ?? '', { clock: createFixedClock(START) });
      machines = vi.spyOn(db.machines, 'get').mockRejectedValue(new Error('database busy'));
    });

    const panel = (await screen.findByRole('heading', { name: 'Seated leg press' })).closest(
      'section',
    ) as HTMLElement;

    // The failure is named, in place, with a retry.
    expect(await within(panel).findByText(copy.strengthContextErrorTitle)).toBeInTheDocument();
    expect(within(panel).getByText(copy.previousUnavailable)).toBeInTheDocument();
    // And neither of the two claims a failed read must never turn into.
    expect(within(panel).queryByText(copy.previousNone)).not.toBeInTheDocument();
    expect(within(panel).queryByText(copy.firstComparableResult)).not.toBeInTheDocument();

    machines?.mockRestore();
    await user.click(within(panel).getByRole('button', { name: copy.retry }));

    // The real history appears, and says where it came from.
    expect(await within(panel).findByText(/60 kg/)).toBeInTheDocument();
    expect(within(panel).queryByText(copy.previousUnavailable)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('claims no personal best over history it never read', async () => {
    const view = await render(async (db) => {
      await seedHistory(db);
      const sessionId = await startTemplateSession(db, START, 5000);
      const detail = await getSessionDetail(db, sessionId);
      const press = detail?.activities.find(
        (activity) => activity.displayName === 'Seated leg press',
      );
      const set = await addStrengthSet(db, press?.id ?? '', { clock: createFixedClock(START) });
      await completeStrengthSet(
        db,
        set.id,
        { reps: 12, loadValue: 80, loadUnit: 'kg', loadGrams: 80_000 },
        { clock: createFixedClock(START) },
      );
      vi.spyOn(db.machines, 'get').mockRejectedValue(new Error('database busy'));
    });

    const panel = (await screen.findByRole('heading', { name: 'Seated leg press' })).closest(
      'section',
    ) as HTMLElement;

    // 80 kg really would beat the stored 60 kg. Saying so requires having read it.
    expect(await within(panel).findByText(copy.recordsUnavailable)).toBeInTheDocument();
    expect(within(panel).queryByText(copy.recordHeading)).not.toBeInTheDocument();
    expect(within(panel).queryByText(copy.firstComparableResult)).not.toBeInTheDocument();

    vi.restoreAllMocks();
    await destroyTestDatabase(view.db);
  });
});

describe('a catalog that cannot be read while adding a machine', () => {
  it('never reports an unreadable catalog as an empty one', async () => {
    const user = userEvent.setup();
    let toArray: { mockRestore: () => void } | undefined;
    const view = await render(async (db) => {
      await startTemplateSession(db, START, 5000);
      toArray = vi.spyOn(db.mediaAssets, 'toArray').mockRejectedValue(new Error('database busy'));
    });
    await screen.findByRole('heading', { name: 'Seated leg press' });

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));

    expect(await screen.findByText(copy.pickerCatalogErrorTitle)).toBeInTheDocument();
    // The sentence that would send the user off to re-add machines he already has.
    expect(screen.queryByText(copy.pickerNoMachinesTitle)).not.toBeInTheDocument();

    toArray?.mockRestore();
    const picker = screen.getByRole('region', { name: copy.pickerHeading });
    await user.click(within(picker).getByRole('button', { name: copy.retry }));

    await waitFor(() => {
      expect(
        within(picker).getByRole('button', { name: /Selectorized seated leg press/ }),
      ).toBeInTheDocument();
    });
    expect(within(picker).queryByText(copy.pickerCatalogErrorTitle)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('never reports an unreadable machine as a machine with no exercises', async () => {
    const user = userEvent.setup();
    const view = await render(async (db) => {
      await startTemplateSession(db, START, 5000);
    });
    await screen.findByRole('heading', { name: 'Seated leg press' });

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    const picker = screen.getByRole('region', { name: copy.pickerHeading });
    const detail = vi.spyOn(view.db.machines, 'get').mockRejectedValue(new Error('database busy'));

    await user.click(
      await within(picker).findByRole('button', { name: /Selectorized seated leg press/ }),
    );

    expect(await within(picker).findByText(copy.pickerMachineErrorTitle)).toBeInTheDocument();
    expect(within(picker).queryByText(copy.pickerNoExercisesTitle)).not.toBeInTheDocument();

    detail.mockRestore();
    await user.click(within(picker).getByRole('button', { name: copy.retry }));

    // The exercise step arrives with the machine's real exercises on it.
    expect(await within(picker).findByRole('button', { name: /^Choose / })).toBeInTheDocument();
    expect(within(picker).queryByText(copy.pickerMachineErrorTitle)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
