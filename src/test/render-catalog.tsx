import { act, render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

import { App } from '../app/App.tsx';
import { DatabaseProvider, type DatabaseInitializer } from '../app/DatabaseProvider.tsx';
import { PwaProvider } from '../app/PwaProvider.tsx';
import type { ServiceWorkerRegistrar } from '../app/register-service-worker.ts';
import { preloadRoutes } from '../app/route-modules.ts';
import { WIDE_LAYOUT_QUERY } from '../app/useMediaQuery.ts';
import type { GymTrackerDatabase } from '../db/database.ts';
import { createInitializedDatabase } from '../db/initialize.ts';
import { I18nProvider } from '../i18n/I18nProvider.tsx';
import { uniqueDatabaseName } from './database.ts';
import { testClock, testIds } from './fixtures.ts';
import { setMatchMedia } from './media.ts';

/**
 * Renders the real application against a real (in-memory) database.
 *
 * Component tests for the catalog need actual seeded records: the point of most of them
 * is that the four photographed machines reach the screen with their confirmation notes
 * intact, which a stubbed repository would assert nothing about. `fake-indexeddb` makes
 * that cheap, and each test gets its own uniquely named database so none can observe
 * another's writes.
 */
export interface CatalogRenderResult extends RenderResult {
  db: GymTrackerDatabase;
}

export interface RenderCatalogOptions {
  route?: string;
  wide?: boolean;
  /** Runs against the initialized database before anything is rendered. */
  seed?: (db: GymTrackerDatabase) => Promise<void>;
  /** Renders this instead of the router, inside the same providers. */
  children?: ReactNode;
  /** Service-worker behaviour for this render. jsdom reports none by default. */
  pwa?: { registrar?: ServiceWorkerRegistrar; supported?: boolean };
}

export async function renderWithDatabase({
  route = '/machines',
  wide = false,
  seed,
  children,
  pwa = {},
}: RenderCatalogOptions = {}): Promise<CatalogRenderResult> {
  setMatchMedia((query) => wide && query === WIDE_LAYOUT_QUERY);
  // Routes are code-split. Resolving the modules before rendering means the assertions
  // below wait for a real page rather than for a chunk fetch.
  await preloadRoutes();

  const { db } = await createInitializedDatabase(uniqueDatabaseName('catalog-ui'), {
    clock: testClock,
    ids: testIds(),
  });
  if (seed) {
    await seed(db);
  }

  const initialize: DatabaseInitializer = () =>
    Promise.resolve({
      db,
      seed: { applied: false, fromVersion: 2, toVersion: 2, appliedSteps: [] },
    });

  const result = render(
    <I18nProvider>
      <DatabaseProvider initialize={initialize}>
        <PwaProvider
          supported={pwa.supported ?? false}
          {...(pwa.registrar ? { registrar: pwa.registrar } : {})}
        >
          <MemoryRouter initialEntries={[route]}>{children ?? <App />}</MemoryRouter>
        </PwaProvider>
      </DatabaseProvider>
    </I18nProvider>,
  );

  /*
   * The initializer above resolves in a microtask, so `DatabaseProvider` reaches `ready`
   * just after `render` has returned -- outside React's test scope, which reported it as an
   * unwrapped update in every suite that renders this way. Draining that microtask here
   * hands the test a database that is already open, which is what every caller then waits
   * for anyway.
   *
   * The lazily loaded route settles the same way, one link further down the promise
   * chain, so more than one turn is drained. Every promise involved has already
   * resolved -- this waits for readiness that exists, it does not sleep hoping for it.
   */
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  return Object.assign(result, { db });
}
