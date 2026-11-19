import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getActiveSession } from '../db/workout-repository.ts';
import { useDatabaseState } from '../shared/database-context.ts';
import {
  type InstallState,
  PwaContext,
  type PwaContextValue,
  type UpdateRefusal,
  type UpdateState,
} from '../shared/pwa/pwa-context.ts';
import { useDatabaseQuery } from '../shared/useDatabaseQuery.ts';
import {
  browserServiceWorkerRegistrar,
  isServiceWorkerSupported,
  type ApplyUpdate,
  type ServiceWorkerRegistrar,
} from './register-service-worker.ts';

/**
 * Owns service-worker registration, the update decision, and the install prompt.
 *
 * The composition root is the right home for all three: they are properties of this
 * application as a deployed thing rather than of any feature, and they need the database
 * to answer the one question that governs an update -- is a workout open right now.
 *
 * ## Why an update never happens by itself
 *
 * Applying an update reloads the page. A reload during a workout throws away whatever is
 * in a field and, worse, swaps the shell for one that may expect a schema the stored data
 * has not migrated to. So the waiting worker waits: `registerType: 'prompt'` and
 * `skipWaiting: false` in `vite.config.ts` mean nothing takes over until `applyUpdate`
 * sends the message, and `applyUpdate` refuses while a session is in progress.
 *
 * ## What actually enforces it, and what only describes it
 *
 * `applyingRef` is the **synchronous** part: it is checked and set before the first await,
 * so a second tap — or a click that arrives before React has re-rendered anything — cannot
 * start a second attempt. Nothing about the guarantee waits for a render.
 *
 * The refusal itself reads the **stored session**, every time, because that row is the
 * authority and this component's copy of it is only as fresh as its last read. A ref
 * cannot be both fresh and authoritative: `workoutOpenRef` would be stale in one direction
 * after a workout starts in another tab, and stale in the other direction the moment a
 * workout is finished — and a stale "no" would leave somebody unable to update at all
 * until something else happened to re-read. So the ref decides only whether to *show* the
 * applying state, sparing a flicker when the answer is probably "no"; it never decides the
 * outcome. There is exactly one path to a reload and the database sits on it.
 */

/** The event browsers fire when they are willing to offer an install. Not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaProviderProps {
  /** Injectable so the update flow can be driven without a real service worker. */
  registrar?: ServiceWorkerRegistrar;
  /** Injectable for the same reason; jsdom reports no service worker support. */
  supported?: boolean;
  children: ReactNode;
}

/** A short label for the UI. Never includes record data or a raw stack trace. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return 'UnknownError';
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function PwaProvider({
  registrar = browserServiceWorkerRegistrar,
  supported,
  children,
}: PwaProviderProps): ReactNode {
  const serviceWorkerSupported = supported ?? isServiceWorkerSupported();

  const [update, setUpdate] = useState<UpdateState>({ status: 'none' });
  const [registrationError, setRegistrationError] = useState<string | undefined>(undefined);
  const [offlineReady, setOfflineReady] = useState(false);
  const [postponed, setPostponed] = useState(false);
  const [refusedBecause, setRefusedBecause] = useState<UpdateRefusal | undefined>(undefined);
  /*
   * Read once at mount rather than set from an effect: whether this page is already
   * running in an installed window is knowable during the first render, and writing it
   * from an effect would render the "not installed" copy first and then replace it.
   */
  const [install, setInstall] = useState<InstallState>(() =>
    detectStandalone() ? { status: 'installed' } : { status: 'unavailable' },
  );

  const applyRef = useRef<ApplyUpdate | undefined>(undefined);
  const installPromptRef = useRef<BeforeInstallPromptEvent | undefined>(undefined);
  /** The last read, used to describe the situation. It never decides the outcome. */
  const workoutOpenRef = useRef(false);
  /** The synchronous guarantee: one attempt per user action, taken before any await. */
  const applyingRef = useRef(false);

  const { state: dbState } = useDatabaseState();
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  /*
   * Read once at start-up and again the moment an update appears, which is when the
   * answer starts mattering. This read exists so the notice can explain, before the tap,
   * why an update is likely to be refused. It is never what makes the refusal true.
   */
  const activeSession = useDatabaseQuery((database) => getActiveSession(database), [update.status]);
  const hasOpenWorkout =
    activeSession.state.status === 'ready' && activeSession.state.data !== undefined;

  useLayoutEffect(() => {
    workoutOpenRef.current = hasOpenWorkout;
  }, [hasOpenWorkout]);

  useEffect(() => {
    if (!serviceWorkerSupported) {
      return;
    }
    let cancelled = false;

    void registrar
      .register({
        onNeedRefresh: () => {
          if (!cancelled) {
            setPostponed(false);
            setUpdate({ status: 'available' });
          }
        },
        onOfflineReady: () => {
          if (!cancelled) {
            setOfflineReady(true);
          }
        },
        onRegisterError: (error: unknown) => {
          if (!cancelled) {
            // Registration failing is not a broken app: it is an app without the offline
            // shell. It is reported where the user asked about offline support, and
            // nowhere else, because there is nothing for them to do about it mid-workout.
            setRegistrationError(describeFailure(error));
          }
        },
      })
      .then(
        (apply) => {
          applyRef.current = apply;
        },
        (error: unknown) => {
          if (!cancelled) {
            setRegistrationError(describeFailure(error));
          }
        },
      );

    return () => {
      cancelled = true;
    };
  }, [registrar, serviceWorkerSupported]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onBeforeInstallPrompt = (event: Event): void => {
      // Prevented so the browser's own banner does not appear over a workout; the
      // captured event is offered from Settings instead, where it is expected.
      event.preventDefault();
      installPromptRef.current = event as BeforeInstallPromptEvent;
      setInstall({ status: 'available' });
    };
    const onInstalled = (): void => {
      installPromptRef.current = undefined;
      setInstall({ status: 'installed' });
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (applyingRef.current) {
      return;
    }
    applyingRef.current = true;
    setRefusedBecause(undefined);
    /*
     * Only claim to be applying when the last read gives no reason to expect a refusal.
     * This is presentation: it saves a flash of "Applying the update" in front of a
     * message saying the opposite, and it decides nothing.
     */
    if (!workoutOpenRef.current) {
      setUpdate({ status: 'applying' });
    }

    void (async () => {
      try {
        if (db) {
          // The authority, consulted on every attempt. A workout may have been started in
          // another tab since the last read -- or finished, which is why a stale ref is
          // never allowed to refuse on its own.
          const active = await getActiveSession(db);
          workoutOpenRef.current = active !== undefined;
          if (active) {
            applyingRef.current = false;
            setRefusedBecause('workout_in_progress');
            setUpdate({ status: 'available' });
            return;
          }
        }
        setUpdate({ status: 'applying' });
        const apply = applyRef.current;
        if (!apply) {
          throw new Error('NoWaitingServiceWorker');
        }
        // Sends SKIP_WAITING and reloads. Nothing after this line is expected to run.
        await apply(true);
      } catch (error) {
        // The running version is untouched, so the notice offers the update again.
        applyingRef.current = false;
        setUpdate({ status: 'failed', reason: describeFailure(error) });
      }
    })();
  }, [db]);

  const postponeUpdate = useCallback(() => {
    setRefusedBecause(undefined);
    setPostponed(true);
  }, []);

  const promptInstall = useCallback(() => {
    const event = installPromptRef.current;
    if (!event) {
      return;
    }
    installPromptRef.current = undefined;
    void (async () => {
      try {
        await event.prompt();
        const choice = await event.userChoice;
        // `accepted` is the browser's own report that it is proceeding. A dismissal is a
        // decision, not a failure, and is never reported as an error.
        setInstall(
          choice.outcome === 'accepted' ? { status: 'installed' } : { status: 'dismissed' },
        );
      } catch {
        setInstall({ status: 'unavailable' });
      }
    })();
  }, []);

  const value = useMemo<PwaContextValue>(
    () => ({
      serviceWorkerSupported,
      offlineReady,
      registrationError,
      update,
      updateBlocked: hasOpenWorkout,
      updateRefusedBecause: refusedBecause,
      applyUpdate,
      postponeUpdate,
      updatePostponed: postponed,
      install,
      promptInstall,
    }),
    [
      serviceWorkerSupported,
      offlineReady,
      registrationError,
      update,
      hasOpenWorkout,
      refusedBecause,
      applyUpdate,
      postponeUpdate,
      postponed,
      install,
      promptInstall,
    ],
  );

  return <PwaContext.Provider value={value}>{children}</PwaContext.Provider>;
}
