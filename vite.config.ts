/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Gym Tracker is a single-page app: the dev and preview servers must fall back to
 * index.html so that every route (/workout, /machines, ...) survives a direct reload.
 *
 * `vite-plugin-pwa@1.3.0` is the version that declares Vite 8 support; earlier 1.x
 * releases stop at Vite 7. It is pinned rather than ranged for the same reason the rest
 * of this project pins: an upgrade that changes the generated service worker is a
 * deliberate, reviewed change, not something a fresh install decides.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      /*
       * `prompt`, never `autoUpdate`. A new shell replacing the running one mid-workout
       * would take the page out from under someone standing at a machine, and the app has
       * no way to prove the swap is safe for whatever is on screen. The waiting worker
       * stays waiting until the user says so, and `src/app/PwaProvider.tsx` refuses to
       * say so while a workout is open.
       */
      registerType: 'prompt',
      // Registration is written by hand in `src/app/register-service-worker.ts` so it can
      // be injected in tests and so nothing registers before the app decides to.
      injectRegister: null,
      includeAssets: [],
      manifest: {
        id: '/',
        name: 'Gym Tracker',
        short_name: 'Gym Tracker',
        description:
          'A private personal workout journal. Records are stored on this device, in this browser.',
        lang: 'en',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // Both taken from `src/styles/tokens.css`, so the installed shell matches the app.
        theme_color: '#14171c',
        background_color: '#14171c',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        /*
         * The whole shell: the entry bundle, every route chunk, the stylesheet, the
         * manifest icons, and the normalized machine photographs. All of it is needed for
         * the app to open, navigate, and show a machine with no network at all.
         */
        globPatterns: ['**/*.{js,css,html,webp,png,svg,ico,woff2}'],
        // A direct reload of /history offline must return the app shell, not a 404.
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        /*
         * The two halves of the deliberate update contract, stated rather than inherited:
         * a new worker installs and then waits, and it does not take over the open pages
         * until the user asks. Workbox's `SKIP_WAITING` message is what `updateSW(true)`
         * sends, and nothing else sends it.
         */
        skipWaiting: false,
        clientsClaim: false,
        /*
         * No runtime caching, deliberately. Every byte this app needs is precached at
         * install time, so there is no rule that could reach a host we do not control --
         * and no rule that could cache a workout record or an exported backup, neither of
         * which is ever an HTTP response in the first place.
         */
        runtimeCaching: [],
      },
      /*
       * No service worker in development. A worker serving a stale shell while the dev
       * server is hot-reloading makes every unrelated bug harder to read; the production
       * preview is where the real worker is exercised, which is also what the E2E suite
       * runs against.
       */
      devOptions: { enabled: false },
    }),
  ],
  appType: 'spa',
  server: {
    port: 5173,
    fs: {
      // `source-assets/` contains the sample equipment JPEGs.
      // Only the normalized derivatives in `public/machines/` are ever served, and only
      // those reach `dist/`; the dev server must not quietly expose the originals.
      deny: ['source-assets/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
    // Component tests drive a real IndexedDB through Dexie, many round trips per test,
    // in workers that share one machine. The default five seconds is comfortable alone
    // and tight for the whole suite at once; this is headroom, not a relaxed assertion.
    testTimeout: 20_000,
  },
});
