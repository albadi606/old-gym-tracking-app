import type { ReactNode } from 'react';

import { useStrings } from '../i18n/context.ts';
import { usePwa } from '../shared/pwa/pwa-context.ts';
import { StatusMessage } from './StatusMessage.tsx';

/**
 * The one place a waiting update is offered.
 *
 * It renders inside the main landmark, above the route, so it is announced when it
 * appears and reachable by keyboard immediately after the skip link -- and so it never
 * covers the primary action of whatever screen is open.
 *
 * Nothing here decides anything. `applyUpdate` refuses while a workout is open -- first
 * against a ref, synchronously, and then against the stored session.
 *
 * The button is deliberately **not** disabled when the app believes a workout is open.
 * That belief comes from a read, and a read goes out of date the moment the workout ends;
 * a disabled control would then be wrong in the direction that blocks somebody from
 * something they are entitled to do. The explanation is shown from that read because it
 * is useful before the tap, and the tap itself asks the database again -- so a stale
 * "you cannot" costs nothing, while a stale "you can" is answered honestly in place.
 */
export function UpdateNotice(): ReactNode {
  const strings = useStrings();
  const copy = strings.pwa;
  const {
    update,
    updateBlocked,
    updateRefusedBecause,
    updatePostponed,
    applyUpdate,
    postponeUpdate,
  } = usePwa();

  if (update.status === 'applying') {
    return <StatusMessage tone="info" title={copy.updateApplyingTitle} />;
  }

  if (update.status === 'failed') {
    return (
      <StatusMessage
        tone="error"
        title={copy.updateFailedTitle}
        body={`${copy.updateFailedBody} (${update.reason})`}
        action={
          <button type="button" className="button button--secondary" onClick={applyUpdate}>
            {copy.updateRetry}
          </button>
        }
      />
    );
  }

  if (update.status !== 'available' || updatePostponed) {
    return null;
  }

  const blocked = updateBlocked || updateRefusedBecause === 'workout_in_progress';

  return (
    <StatusMessage
      tone={blocked ? 'warning' : 'info'}
      title={copy.updateTitle}
      body={blocked ? copy.updateBlockedBody : copy.updateBody}
      action={
        <div className="status__buttons">
          <button type="button" className="button button--primary" onClick={applyUpdate}>
            {copy.updateNow}
          </button>
          <button type="button" className="button button--secondary" onClick={postponeUpdate}>
            {copy.updateLater}
          </button>
        </div>
      }
    />
  );
}
