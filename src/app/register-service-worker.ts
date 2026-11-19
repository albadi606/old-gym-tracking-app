/**
 * The one place that touches the generated service worker.
 *
 * `virtual:pwa-register` only exists inside a Vite build, so it is reached through a
 * dynamic import behind a port. That keeps two promises: a test can drive the whole
 * update flow without a service worker, and nothing registers merely because a module
 * was imported.
 */

export interface ServiceWorkerRegistrar {
  /**
   * Starts registration.
   *
   * Returns the function that applies a waiting update. Calling it with `true` sends
   * `SKIP_WAITING` and reloads the page -- the only path in the app that does either, and
   * it runs solely from a deliberate user action with no workout open.
   */
  register(handlers: ServiceWorkerHandlers): Promise<ApplyUpdate>;
}

export interface ServiceWorkerHandlers {
  /** A newer version finished downloading and is waiting for permission to take over. */
  onNeedRefresh: () => void;
  /** The shell and its assets are precached; the app now opens with no network. */
  onOfflineReady: () => void;
  /** Registration itself failed. The app keeps working; it just is not offline-capable. */
  onRegisterError: (error: unknown) => void;
}

export type ApplyUpdate = (reloadPage?: boolean) => Promise<void>;

export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * The real registrar.
 *
 * The import is inside the function so that neither jsdom nor a browser without service
 * workers ever evaluates the virtual module.
 */
export const browserServiceWorkerRegistrar: ServiceWorkerRegistrar = {
  async register(handlers: ServiceWorkerHandlers): Promise<ApplyUpdate> {
    const { registerSW } = await import('virtual:pwa-register');
    return registerSW({
      immediate: true,
      onNeedRefresh: handlers.onNeedRefresh,
      onOfflineReady: handlers.onOfflineReady,
      onRegisterError: handlers.onRegisterError,
    });
  },
};
