import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { en } from '../i18n/en.ts';
import { ROUTE_PATHS } from '../shared/navigation/routes.ts';
import { makeBackupSession } from '../test/backup.ts';
import { destroyTestDatabase } from '../test/database.ts';
import { renderWithDatabase } from '../test/render-catalog.tsx';
import type { GymTrackerDatabase } from '../db/database.ts';
import type {
  ApplyUpdate,
  ServiceWorkerHandlers,
  ServiceWorkerRegistrar,
} from './register-service-worker.ts';

const copy = en.pwa;

/**
 * The update contract, driven without a service worker.
 *
 * A real waiting worker cannot be produced in jsdom, so the registrar is a port and the
 * test plays the part of the browser: it says "a new version is waiting" and then watches
 * what the app does. What is being asserted is the app's own rule, which is the part that
 * could go wrong — the worker itself is exercised for real by the offline E2E suite.
 *
 * The rule: nothing reloads until the user asks, and the app refuses to ask while a
 * workout is open, because a reload during a set throws away whatever is in the fields.
 */
interface FakeRegistrar {
  registrar: ServiceWorkerRegistrar;
  /** Plays the browser telling the page that a newer version has finished downloading. */
  announceUpdate: () => Promise<void>;
  announceOfflineReady: () => Promise<void>;
  failRegistration: (reason: string) => Promise<void>;
  /** One entry per `updateSW(reload)` call, recording whether a reload was requested. */
  applied: boolean[];
  makeApplyFail: () => void;
}

function fakeRegistrar(options: { failRegister?: boolean } = {}): FakeRegistrar {
  let handlers: ServiceWorkerHandlers | undefined;
  const applied: boolean[] = [];
  let applyFails = false;

  const apply: ApplyUpdate = (reloadPage) => {
    applied.push(reloadPage ?? false);
    return applyFails ? Promise.reject(new Error('SecurityError')) : Promise.resolve();
  };

  return {
    registrar: {
      register(incoming: ServiceWorkerHandlers): Promise<ApplyUpdate> {
        handlers = incoming;
        return options.failRegister
          ? Promise.reject(new Error('SecurityError'))
          : Promise.resolve(apply);
      },
    },
    announceUpdate: async () => {
      await act(async () => {
        handlers?.onNeedRefresh();
        await Promise.resolve();
      });
    },
    announceOfflineReady: async () => {
      await act(async () => {
        handlers?.onOfflineReady();
        await Promise.resolve();
      });
    },
    failRegistration: async (reason: string) => {
      await act(async () => {
        handlers?.onRegisterError(new Error(reason));
        await Promise.resolve();
      });
    },
    applied,
    makeApplyFail: () => {
      applyFails = true;
    },
  };
}

async function seedOpenWorkout(db: GymTrackerDatabase): Promise<void> {
  await db.workoutSessions.add(
    makeBackupSession({
      name: 'A workout still in progress',
      status: 'in_progress',
      completedAt: undefined,
    }),
  );
}

describe('a waiting update', () => {
  it('is offered rather than applied, and nothing reloads on its own', async () => {
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      pwa: { registrar: fake.registrar, supported: true },
    });

    expect(screen.queryByText(copy.updateTitle)).not.toBeInTheDocument();
    await fake.announceUpdate();

    expect(await screen.findByText(copy.updateTitle)).toBeInTheDocument();
    // The decisive assertion: the app has asked for nothing.
    expect(fake.applied).toEqual([]);

    await destroyTestDatabase(view.db);
  });

  it('applies only when the user says so', async () => {
    const user = userEvent.setup();
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.announceUpdate();

    await user.click(await screen.findByRole('button', { name: copy.updateNow }));
    await waitFor(() => {
      expect(fake.applied).toEqual([true]);
    });

    await destroyTestDatabase(view.db);
  });

  it('leaves the running version completely usable when postponed', async () => {
    const user = userEvent.setup();
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.announceUpdate();

    await user.click(await screen.findByRole('button', { name: copy.updateLater }));

    expect(screen.queryByText(copy.updateTitle)).not.toBeInTheDocument();
    expect(fake.applied).toEqual([]);
    // The page is still the page.
    expect(screen.getByRole('heading', { level: 1, name: en.pages.today.heading })).toBeVisible();

    await destroyTestDatabase(view.db);
  });

  it('offers the postponed update again in Settings rather than losing it', async () => {
    const user = userEvent.setup();
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.settings,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.announceUpdate();
    await user.click(await screen.findByRole('button', { name: copy.updateLater }));

    expect(await screen.findByText(copy.updateAvailableSettingsTitle)).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('an update while a workout is open', () => {
  it('is refused, and says which thing to do first', async () => {
    const user = userEvent.setup();
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      seed: seedOpenWorkout,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.announceUpdate();

    expect(await screen.findByText(copy.updateBlockedBody)).toBeInTheDocument();

    // The button stays usable on purpose: what refuses is the guard, not the attribute.
    await user.click(await screen.findByRole('button', { name: copy.updateNow }));
    await waitFor(() => {
      expect(screen.getByText(copy.updateBlockedBody)).toBeInTheDocument();
    });
    expect(fake.applied).toEqual([]);

    await destroyTestDatabase(view.db);
  });

  it('is allowed once the workout has been finished', async () => {
    const user = userEvent.setup();
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      seed: seedOpenWorkout,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.announceUpdate();
    await screen.findByText(copy.updateBlockedBody);

    /*
     * The workout ends. Nothing tells the update about it, and the app's last read still
     * says a workout is open -- which is exactly the case that must not leave the user
     * stuck. The tap asks the database again, finds nothing, and proceeds.
     */
    await view.db.workoutSessions.clear();

    await user.click(await screen.findByRole('button', { name: copy.updateNow }));
    await waitFor(() => {
      expect(fake.applied).toEqual([true]);
    });

    await destroyTestDatabase(view.db);
  });
});

describe('when an update cannot be applied', () => {
  it('leaves the current version usable and offers another attempt', async () => {
    const user = userEvent.setup();
    const fake = fakeRegistrar();
    fake.makeApplyFail();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.announceUpdate();

    await user.click(await screen.findByRole('button', { name: copy.updateNow }));

    expect(await screen.findByText(copy.updateFailedTitle)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: en.pages.today.heading })).toBeVisible();
    expect(screen.getByRole('button', { name: copy.updateRetry })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('when the service worker cannot be registered', () => {
  it('says so where offline support is discussed, and raises no alarm elsewhere', async () => {
    const fake = fakeRegistrar();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      pwa: { registrar: fake.registrar, supported: true },
    });
    await fake.failRegistration('SecurityError');

    // Nothing on the workout-facing screen; there is nothing the user can do about it there.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(copy.updateFailedTitle)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('reports an unsupported browser honestly in Settings', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.settings,
      pwa: { supported: false },
    });

    expect(await screen.findByText(copy.offlineUnsupportedTitle)).toBeInTheDocument();
    // No install button that could not work.
    expect(screen.queryByRole('button', { name: copy.installAction })).not.toBeInTheDocument();
    expect(screen.getByText(copy.installManualBody)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
