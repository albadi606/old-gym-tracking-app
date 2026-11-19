import { createContext, useContext } from 'react';

/**
 * What the app knows about being installed and about being replaced by a newer version.
 *
 * It lives in `shared/` for the same reason the route and database contracts do: `app/`
 * is the composition root that owns registration, but Settings needs to *read* this
 * state, and no feature may import the composition root.
 *
 * Nothing here talks to a service worker. `app/PwaProvider.tsx` does that and publishes
 * the result; this module only says what the result looks like.
 */

/**
 * A newer version of the app has been downloaded and is waiting.
 *
 * `available` never becomes `applying` on its own. The waiting worker keeps waiting
 * until the user asks for it, because the alternative is a reload arriving while
 * somebody is standing at a machine with a set half entered.
 */
export type UpdateState =
  | { status: 'none' }
  | { status: 'available' }
  /** The user asked, no workout is open, and the new shell is taking over. */
  | { status: 'applying' }
  /** A short, non-identifying label. The current version stays usable. */
  | { status: 'failed'; reason: string };

/**
 * Why an update was refused.
 *
 * `workout_in_progress` is the only refusal the app generates itself, and it is a
 * statement about the database rather than about the button: the check runs
 * synchronously against a ref and again against the stored session before anything
 * reloads.
 */
export type UpdateRefusal = 'workout_in_progress';

export type InstallState =
  /** Running from an installed icon already. */
  | { status: 'installed' }
  /** The browser offered an install prompt and it is still usable. */
  | { status: 'available' }
  /** The user closed the browser's prompt. Not an error, and not a failure to report. */
  | { status: 'dismissed' }
  /**
   * No install event is available here. Some browsers never fire one and install from
   * their own menu instead, so the app explains that rather than rendering a button
   * that cannot work.
   */
  | { status: 'unavailable' };

export interface PwaContextValue {
  /** `false` when the browser has no service worker at all, or in a test environment. */
  serviceWorkerSupported: boolean;
  /** True once the shell and its assets are precached and the app can open offline. */
  offlineReady: boolean;
  /**
   * Registration itself failed: a short, non-identifying label.
   *
   * Kept apart from `update` on purpose. A failed registration means the app is not
   * offline-capable, which belongs on the screen where the user asked about that. A
   * failed *update* is a thing the user just tried to do, and deserves to be said where
   * they tried it.
   */
  registrationError: string | undefined;
  update: UpdateState;
  /**
   * A workout is open, so an update would reload the page out from under it.
   *
   * This is presentation -- it disables the control and explains why before the tap. The
   * guard is the synchronous check inside `applyUpdate`, and then the stored session.
   */
  updateBlocked: boolean;
  /**
   * Set when the last `applyUpdate` was refused, and cleared when it is allowed.
   * Presentation reads this; it is never the guard.
   */
  updateRefusedBecause: UpdateRefusal | undefined;
  /** Applies the waiting update. Refuses synchronously while a workout is open. */
  applyUpdate: () => void;
  /** "Later": hides the notice and leaves the running version completely usable. */
  postponeUpdate: () => void;
  /** True while the notice has been postponed; Settings still offers the update. */
  updatePostponed: boolean;
  install: InstallState;
  /** Shows the browser's install prompt. Does nothing when there is none to show. */
  promptInstall: () => void;
}

const inertValue: PwaContextValue = {
  serviceWorkerSupported: false,
  offlineReady: false,
  registrationError: undefined,
  update: { status: 'none' },
  updateBlocked: false,
  updateRefusedBecause: undefined,
  applyUpdate: () => undefined,
  postponeUpdate: () => undefined,
  updatePostponed: false,
  install: { status: 'unavailable' },
  promptInstall: () => undefined,
};

export const PwaContext = createContext<PwaContextValue>(inertValue);

export function usePwa(): PwaContextValue {
  return useContext(PwaContext);
}
