import type { ReactNode } from 'react';

import type { LoadUnit } from '../../domain/enums.ts';
import { formatDurationClock } from '../../domain/format.ts';
import type { SessionActivity, StrengthSet } from '../../domain/schemas.ts';
import { formatLoadValue, fromCanonicalGrams } from '../../domain/units.ts';
import {
  type StrengthActivitySummary,
  type StrengthSetLine,
  summarizeStrength,
} from '../../domain/workout/strength-summary.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatCount, formatMessage } from '../../shared/format-message.ts';

/**
 * What each machine recorded, machine by machine.
 *
 * The two rules the cardio summary settled, applied to sets:
 *
 * **A value is shown because it exists.** A set is listed under "saved but never marked
 * done" precisely because something was found in it, so every field that can make it
 * qualify is rendered here. Listing a set for its note and then not showing the note is
 * the summary announcing a fact and withholding it.
 *
 * **An aggregate that has no common basis is not reported.** A total is shown only when
 * every finished set means the same thing by its number, was performed on the same side,
 * and recorded both a load and its reps. Otherwise the reason is stated and the per-set
 * rows -- which are always truthful -- carry the session on their own.
 */

export interface StrengthSummaryProps {
  activities: readonly SessionActivity[];
  strengthSets: readonly StrengthSet[];
}

export function StrengthSummary({ activities, strengthSets }: StrengthSummaryProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const summary = summarizeStrength(activities, strengthSets);

  if (summary.activities.length === 0) {
    return null;
  }

  return (
    <>
      <h3 className="summary__subheading">{copy.strengthSummaryHeading}</h3>
      <ol className="summary__strength">
        {summary.activities.map((activity) => (
          <StrengthActivityRow key={activity.activityId} activity={activity} />
        ))}
      </ol>
    </>
  );
}

function StrengthActivityRow({ activity }: { activity: StrengthActivitySummary }): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  return (
    <li className="summary__strength-activity">
      <h4 className="summary__strength-heading">{activity.displayName}</h4>
      <p className="summary__strength-count">
        {activity.completedSetCount === 0
          ? copy.strengthNoCompletedSets
          : formatCount(
              copy.strengthCompletedSetsOne,
              copy.strengthCompletedSetsOther,
              activity.completedSetCount,
            )}
      </p>

      <Volume activity={activity} />

      {activity.completed.length === 0 ? null : (
        <ol className="summary__sets">
          {activity.completed.map((line) => (
            <SetLine key={line.setId} line={line} />
          ))}
        </ol>
      )}

      {activity.savedButNotCompleted.length === 0 ? null : (
        <>
          <h5 className="summary__strength-subheading">{copy.strengthSavedNotFinishedHeading}</h5>
          <p className="summary__note">{copy.strengthSavedNotFinishedNote}</p>
          <ol className="summary__sets">
            {activity.savedButNotCompleted.map((line) => (
              <SetLine key={line.setId} line={line} />
            ))}
          </ol>
        </>
      )}
    </li>
  );
}

/**
 * The unit a total should be shown in.
 *
 * Whatever the finished sets were actually recorded in, when they agree. Kilograms only
 * when they do not, because a total assembled from mixed units has to be expressed in
 * something and the canonical form is the honest choice.
 */
function totalUnit(lines: readonly StrengthSetLine[]): LoadUnit {
  const first = lines[0]?.loadUnit;
  if (first === undefined) {
    return 'kg';
  }
  return lines.every((line) => line.loadUnit === first) ? first : 'kg';
}

function Volume({ activity }: { activity: StrengthActivitySummary }): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const volume = activity.volume;

  if (volume === undefined) {
    const reason = activity.volumeUnavailable;
    // Nothing done at all needs no explanation; the count above already said so.
    if (reason === undefined || reason === 'no_completed_sets') {
      return null;
    }
    return (
      <p className="summary__volume-unavailable">
        <span className="summary__volume-label">{copy.strengthVolumeLabel}</span>{' '}
        {strings.pages.workout.volumeUnavailable[reason]}
      </p>
    );
  }

  const unit = totalUnit(activity.completed);
  return (
    <>
      <p className="summary__volume">
        <span className="summary__volume-label">{copy.strengthVolumeLabel}</span>{' '}
        {formatMessage(copy.loadWithUnit, {
          value: formatLoadValue(fromCanonicalGrams(volume.totalGrams, unit)),
          unit: strings.units[unit],
        })}
      </p>
      {/* The basis travels with the number: a per-side total is not a total lifted. */}
      <p className="summary__volume-note">
        {formatMessage(copy.strengthVolumeNote, {
          basis: strings.loadBasis[volume.loadBasis],
          side: strings.bodySide[volume.side],
        })}
      </p>
    </>
  );
}

function SetLine({ line }: { line: StrengthSetLine }): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  return (
    <li className="summary__set">
      <h6 className="summary__set-heading">
        {formatMessage(copy.setSummaryHeading, {
          position: line.position + 1,
          status: strings.setStatus[line.status],
        })}
      </h6>
      <dl className="detail-list">
        {line.reps === undefined ? null : (
          <>
            <dt>{copy.summaryReps}</dt>
            <dd>{String(line.reps)}</dd>
          </>
        )}
        {line.durationSeconds === undefined ? null : (
          <>
            <dt>{copy.summarySetDuration}</dt>
            <dd>{formatDurationClock(line.durationSeconds)}</dd>
          </>
        )}
        {/* Exactly what was entered, in the unit it was entered in. */}
        {line.loadValue === undefined || line.loadUnit === undefined ? null : (
          <>
            <dt>{copy.summaryLoad}</dt>
            <dd>
              {formatMessage(copy.loadWithUnit, {
                value: formatLoadValue(line.loadValue),
                unit: strings.units[line.loadUnit],
              })}
            </dd>
          </>
        )}
        <dt>{copy.summaryLoadBasis}</dt>
        <dd>{strings.loadBasis[line.loadBasis]}</dd>
        <dt>{copy.summarySide}</dt>
        <dd>{strings.bodySide[line.side]}</dd>
        <dt>{copy.summarySetType}</dt>
        <dd>{strings.setType[line.setType]}</dd>
        {line.rpe === undefined ? null : (
          <>
            <dt>{copy.summaryEffort}</dt>
            <dd>{formatMessage(copy.effortOutOfTen, { value: String(line.rpe) })}</dd>
          </>
        )}
        {line.rir === undefined ? null : (
          <>
            <dt>{copy.summaryRir}</dt>
            <dd>{String(line.rir)}</dd>
          </>
        )}
        {line.notes === undefined ? null : (
          <>
            <dt>{copy.summaryNote}</dt>
            {/* Plain text, rendered as text. A note is never markup. */}
            <dd className="summary__segment-note">{line.notes}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
