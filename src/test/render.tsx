import { act, render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../app/App.tsx';
import { DatabaseProvider, type DatabaseInitializer } from '../app/DatabaseProvider.tsx';
import { PwaProvider } from '../app/PwaProvider.tsx';
import type { ServiceWorkerRegistrar } from '../app/register-service-worker.ts';
import { preloadRoutes } from '../app/route-modules.ts';
import { WIDE_LAYOUT_QUERY } from '../app/useMediaQuery.ts';
import type { GymTrackerDatabase } from '../db/database.ts';
import { I18nProvider } from '../i18n/I18nProvider.tsx';
import { setMatchMedia } from './media.ts';

/** A database stand-in: the shell only reads the status, never the records. */
const fakeDatabase = {} as GymTrackerDatabase;

export const readyInitializer: DatabaseInitializer = () =>
  Promise.resolve({
    db: fakeDatabase,
    seed: { applied: false, fromVersion: 1, toVersion: 1, appliedSteps: [] },
  });

/**
 * How the service worker behaves for this render.
 *
 * jsdom has no service worker, so `supported` defaults to false and the PWA surfaces
 * render their honest "this browser cannot store the app" state. A test that drives the
 * update flow supplies both a registrar and `supported: true`.
 */
export interface RenderPwaOptions {
  registrar?: ServiceWorkerRegistrar;
  supported?: boolean;
}

export interface RenderAppOptions {
  route?: string;
  /** `true` renders the wide layout (sidebar); `false` the phone layout (bottom bar). */
  wide?: boolean;
  initialize?: DatabaseInitializer;
  pwa?: RenderPwaOptions;
}

/**
 * Renders the shell with every route module already resolved.
 *
 * Routes are code-split, so a page arrives one microtask after the render rather than
 * during it. The helper awaits the real loaders and then flushes that microtask inside
 * `act`, which is why callers can assert on the page itself instead of on the loading
 * fallback -- readiness is waited for, never slept through.
 */
export async function renderApp({
  route = '/',
  wide = false,
  initialize = readyInitializer,
  pwa = {},
}: RenderAppOptions = {}): Promise<RenderResult> {
  setMatchMedia((query) => wide && query === WIDE_LAYOUT_QUERY);
  await preloadRoutes();

  const result = render(
    <I18nProvider>
      <DatabaseProvider initialize={initialize}>
        <PwaProvider
          supported={pwa.supported ?? false}
          {...(pwa.registrar ? { registrar: pwa.registrar } : {})}
        >
          <MemoryRouter initialEntries={[route]}>
            <App />
          </MemoryRouter>
        </PwaProvider>
      </DatabaseProvider>
    </I18nProvider>,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  return result;
}
