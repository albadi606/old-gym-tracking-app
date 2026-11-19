import type { ReactNode } from 'react';

import { type Clock, systemClock } from '../../domain/clock.ts';
import { formatDurationClock } from '../../domain/format.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useElapsedSeconds } from './useElapsedSeconds.ts';

/**
 * How long since the last set was finished, counting down to the configured rest.
 *
 * Three deliberate properties.
 *
 * **It is derived, never accumulated.** The remaining time is recomputed on every render
 * from the set's stored `completedAt` and the clock; the interval only nudges a render.
 * A counter that added up its own ticks would drift, reset on reload, and stop while the
 * phone slept in a pocket. Because the instant is already in the database, a reload
 * reconstructs the timer exactly rather than restarting it.
 *
 * **It blocks nothing.** No control anywhere is disabled while it runs. Adding a set,
 * editing, copying, completing, finishing, and cancelling all stay available; the timer is
 * information, not a gate, and the note under it says so.
 *
 * **It is not a live region.** A per-second announcement would make the page unusable with
 * a screen reader, so the countdown is ordinary text. Only the single "rest is up" message
 * is a status, and it appears once and then stops changing, so it is announced once.
 */

/** How long the finished message stays on screen before the timer removes itself. */
const GRACE_SECONDS = 60;

export interface RestTimerProps {
  /** The completion instant the rest is measured from. */
  startedAt: string;
  restSeconds: number;
  onDismiss: () => void;
  clock?: Clock;
}

export function RestTimer({
  startedAt,
  restSeconds,
  onDismiss,
  clock = systemClock,
}: RestTimerProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const elapsed = useElapsedSeconds(startedAt, clock);
  const remaining = restSeconds - elapsed;
  const isOver = remaining <= 0;

  /*
   * It takes itself away a minute after the rest is up.
   *
   * Otherwise a session resumed hours later would open with "rest time is up" beside a
   * machine, which is a stale statement dressed as a current one. Deriving the decision
   * from the same instant as the countdown means a reload reaches the same conclusion.
   */
  if (remaining < -GRACE_SECONDS) {
    return null;
  }

  return (
    <div className="rest-timer">
      <p className="rest-timer__value">
        <span className="rest-timer__label">{copy.restHeading}</span>{' '}
        {isOver ? null : (
          <time className="rest-timer__remaining">
            {formatMessage(copy.restRemaining, { value: formatDurationClock(remaining) })}
          </time>
        )}
      </p>
      {/* Announced once, when it appears. Its text never changes afterwards. */}
      {isOver ? (
        <p className="rest-timer__over" role="status">
          {copy.restOver}
        </p>
      ) : null}
      <p className="rest-timer__note">{copy.restNote}</p>
      <button type="button" className="button button--secondary" onClick={onDismiss}>
        {copy.restDismiss}
      </button>
    </div>
  );
}
