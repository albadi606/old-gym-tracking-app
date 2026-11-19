import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { formatDurationClock, formatInstantInZone } from '../../domain/format.ts';
import type { HistorySessionEntry } from '../../domain/history/session-view.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatCount, formatMessage } from '../../shared/format-message.ts';
import { historyDetailPath } from '../../shared/navigation/routes.ts';

/**
 * One workout in the history list.
 *
 * Everything on it is read from the session's own record: the status it reached, the time
 * it started in the zone it was recorded in, and counts of work that was actually marked
 * done. Nothing here derives a number from a plan, and the counts of saved-but-unfinished
 * rows are reported separately rather than folded into the done counts -- a set nobody
 * marked done is not work this card may claim.
 */
export interface HistorySessionCardProps {
  entry: HistorySessionEntry;
  /** Rendered instead of the open link while the entry is in the trash. */
  onRestore?: (() => void) | undefined;
  restoreLabel?: string | undefined;
  restoreBusy?: boolean;
}

export function HistorySessionCard({
  entry,
  onRestore,
  restoreLabel,
  restoreBusy = false,
}: HistorySessionCardProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.history;

  const counts = [
    formatCount(copy.activityCountOne, copy.activityCount, entry.activityCount),
    ...(entry.completedSetCount > 0
      ? [formatCount(copy.completedSetsOne, copy.completedSets, entry.completedSetCount)]
      : []),
    ...(entry.completedSegmentCount > 0
      ? [
          formatCount(
            copy.completedSegmentsOne,
            copy.completedSegments,
            entry.completedSegmentCount,
          ),
        ]
      : []),
  ];

  return (
    <li className="history-card card">
      <div className="history-card__header">
        <h3 className="card__heading">{entry.name}</h3>
        {/* The status is text, never colour alone, and it names the state the record
            reached rather than an interpretation of it. */}
        <p className="history-card__status">{strings.sessionStatus[entry.status]}</p>
      </div>

      <p className="history-card__time">
        {formatMessage(copy.startedAt, {
          time: formatInstantInZone(entry.startedAt, entry.timeZone),
        })}
      </p>
      <p className="history-card__duration">
        {entry.durationSeconds === undefined
          ? copy.durationUnknown
          : formatMessage(copy.duration, {
              duration: formatDurationClock(entry.durationSeconds),
            })}
      </p>
      <p className="history-card__counts">{counts.join(' · ')}</p>

      {entry.savedButNotCompletedCount > 0 ? (
        <p className="history-card__saved">
          {formatMessage(copy.savedNotCompleted, { count: entry.savedButNotCompletedCount })}
        </p>
      ) : null}

      {entry.isDeleted && entry.deletedAt !== undefined ? (
        <p className="history-card__deleted">
          {formatMessage(copy.deletedAt, {
            time: formatInstantInZone(entry.deletedAt, entry.timeZone),
          })}
        </p>
      ) : null}

      {/* Two rows must never share an accessible name, so the open link is named after
          the workout it opens rather than "Open". The visible text carries that name, so
          no aria-label has to repeat it. */}
      <div className="history-card__actions">
        {onRestore === undefined ? (
          <Link className="button button--secondary" to={historyDetailPath(entry.sessionId)}>
            {formatMessage(copy.openSession, { name: entry.name })}
          </Link>
        ) : (
          <button
            type="button"
            className="button button--primary"
            onClick={onRestore}
            aria-busy={restoreBusy}
            aria-label={`${restoreLabel ?? copy.restore}: ${entry.name}`}
          >
            {restoreBusy ? copy.restoring : (restoreLabel ?? copy.restore)}
          </button>
        )}
      </div>
    </li>
  );
}
