import type { ReactNode } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import { useStrings } from '../../i18n/context.ts';
import { usePwa } from '../../shared/pwa/pwa-context.ts';

/**
 * Installing Gym Tracker, and whether it will open without a connection.
 *
 * Every state here is the honest one for the browser the user is actually in. A browser
 * that never offers an install event gets the manual instructions rather than a button
 * that would do nothing; a dismissed prompt is reported as a choice, not as a failure;
 * and a service worker that could not register says so where somebody asked about offline
 * support, instead of raising an alarm over a workout.
 *
 * The update control is here as well as in the shell, because postponing the notice must
 * not be the same as losing the update.
 */
export function InstallSection(): ReactNode {
  const strings = useStrings();
  const copy = strings.pwa;
  const {
    serviceWorkerSupported,
    offlineReady,
    registrationError,
    install,
    promptInstall,
    update,
    updateBlocked,
    updateRefusedBecause,
    applyUpdate,
  } = usePwa();

  const blocked = updateBlocked || updateRefusedBecause === 'workout_in_progress';

  return (
    <section className="card" aria-labelledby="settings-install-heading">
      <h2 id="settings-install-heading" className="card__heading">
        {copy.sectionTitle}
      </h2>

      {install.status === 'installed' ? (
        <StatusMessage tone="success" title={copy.installedTitle} body={copy.installedBody} />
      ) : install.status === 'available' ? (
        <StatusMessage
          tone="info"
          title={copy.installAvailableTitle}
          body={copy.installAvailableBody}
          action={
            <button type="button" className="button button--primary" onClick={promptInstall}>
              {copy.installAction}
            </button>
          }
        />
      ) : install.status === 'dismissed' ? (
        <StatusMessage
          tone="info"
          title={copy.installDismissedTitle}
          body={copy.installDismissedBody}
        />
      ) : (
        <StatusMessage tone="info" title={copy.installManualTitle} body={copy.installManualBody} />
      )}

      {!serviceWorkerSupported ? (
        <StatusMessage
          tone="warning"
          title={copy.offlineUnsupportedTitle}
          body={copy.offlineUnsupportedBody}
        />
      ) : registrationError !== undefined ? (
        <StatusMessage
          tone="warning"
          title={copy.registrationFailedTitle}
          body={`${copy.registrationFailedBody} (${registrationError})`}
        />
      ) : offlineReady ? (
        <StatusMessage tone="success" title={copy.offlineReadyTitle} body={copy.offlineReadyBody} />
      ) : (
        <StatusMessage
          tone="info"
          title={copy.offlineNotReadyTitle}
          body={copy.offlineNotReadyBody}
        />
      )}

      {update.status === 'available' ? (
        <StatusMessage
          tone={blocked ? 'warning' : 'info'}
          title={copy.updateAvailableSettingsTitle}
          body={blocked ? copy.updateBlockedBody : copy.updateBody}
          // The button is not disabled: see `UpdateNotice`. The read explains before the
          // tap; the guard inside `applyUpdate` is what decides.
          action={
            <button type="button" className="button button--primary" onClick={applyUpdate}>
              {copy.updateNow}
            </button>
          }
        />
      ) : update.status === 'none' && serviceWorkerSupported ? (
        <StatusMessage tone="info" title={copy.updateNoneTitle} body={copy.updateNoneBody} />
      ) : null}
    </section>
  );
}
