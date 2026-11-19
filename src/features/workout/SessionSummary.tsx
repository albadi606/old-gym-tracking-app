import type { ReactNode } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import { formatDistanceKilometers, formatDurationClock } from '../../domain/format.ts';
import { roundToDecimals } from '../../domain/numbers.ts';
import type {
  CardioSegment,
  SessionActivity,
  StrengthSet,
  WorkoutSession,
} from '../../domain/schemas.ts';
import { elapsedSecondsSince } from '../../domain/workout/lifecycle.ts';
import { summarizeStrength } from '../../domain/workout/strength-summary.ts';
import { type SegmentComparison, summarizeCardio } from '../../domain/workout/summary.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { StrengthSummary } from './StrengthSummary.tsx';

/**
 * Targets and recorded work, side by side and never merged.
 *
 * The rule the whole component exists to keep: an absent recording is shown as absent,
 * and a present one is never shown as absent. If no segment was marked done, the recorded
 * totals say so instead of quietly repeating the targets, and a segment with no recorded
 * time shows "not recorded" rather than borrowing its planned time.
 *
 * The converse matters just as much and was missed the first time. A segment can hold a
 * distance the user typed and saved without ever marking it done, and such a segment is
 * correctly kept out of the recorded totals -- but reporting "nothing was recorded" while
 * the database holds 3.05 km is the summary lying about the user's own workout. Those
 * observations are listed under their own heading, plainly labelled as saved rather than
 * finished -- and "those observations" means all eight of them. Listing a segment because
 * it holds a note and then showing everything except the note is the same lie in a
 * quieter form, and until history exists this screen is the only place the note can be
 * read at all.
 *
 * Differences are stated, not judged -- there is no language here about falling short.
 */

export interface SessionSummaryProps {
  session: WorkoutSession;
  activities: readonly SessionActivity[];
  segments: readonly CardioSegment[];
  strengthSets: readonly StrengthSet[];
  /**
   * Whether this is the summary of a closed session rather than the running total.
   *
   * The segment-by-segment comparison and the saved-but-not-finished notice belong to the
   * finish summary. During the workout each card already shows its own target directly
   * above the fields being typed into, and every segment being worked on is "saved but not
   * finished", so both would be noise.
   */
  isFinalSummary?: boolean;
}

export function SessionSummary({
  session,
  activities,
  segments,
  strengthSets,
  isFinalSummary = true,
}: SessionSummaryProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const summary = summarizeCardio(segments);
  const strength = summarizeStrength(activities, strengthSets);
  const savedNotFinished = isFinalSummary ? summary.savedButNotCompleted : [];
  /*
   * A segment appears once. The saved-but-not-finished list is a pulled-out subset of the
   * same comparison, so leaving those rows in the list below as well printed every value
   * twice -- and doubling them again once heart rate, effort, and the note were added.
   * Between the two lists every segment is still shown, each under the heading that
   * explains its status.
   */
  const savedNotFinishedIds = new Set(savedNotFinished.map((comparison) => comparison.segmentId));
  const comparisonRows = summary.segments.filter(
    (comparison) => !savedNotFinishedIds.has(comparison.segmentId),
  );

  /*
   * Whose totals these are, said out loud.
   *
   * "Recorded totals" and "Nothing was recorded" were computed from completed cardio
   * segments alone, so a workout containing a finished 10 x 60 kg set printed "Nothing was
   * recorded" a few centimetres above "1 set marked done -- total weight moved 600 kg".
   * Both statements were generated correctly and one of them was a lie about the user's
   * own workout.
   *
   * Two repairs, not one. The cardio headings now name cardio, so they cannot be read as a
   * claim about the session. And the unqualified statement -- that this workout recorded
   * nothing at all -- is made only when it is true of both halves, which is what the
   * session-wide check below decides.
   */
  const hasCardio = segments.length > 0;
  const cardioIsEmpty =
    summary.actual.completedSegmentCount === 0 && summary.savedButNotCompleted.length === 0;
  const strengthIsEmpty = strength.completedSetCount === 0 && !strength.hasSavedButNotCompleted;
  const nothingWasRecorded = cardioIsEmpty && strengthIsEmpty;

  const endedAt = session.completedAt ?? session.cancelledAt;
  const elapsedSeconds =
    endedAt === undefined ? undefined : elapsedSecondsSince(session.startedAt, new Date(endedAt));

  return (
    <section className="summary" aria-labelledby="session-summary-heading">
      <h2 className="summary__heading" id="session-summary-heading">
        {copy.summaryHeading}
      </h2>

      <dl className="detail-list">
        <dt>{copy.summaryStarted}</dt>
        <dd>
          <time dateTime={session.startedAt}>{formatInstant(session.startedAt)}</time>
        </dd>
        {endedAt === undefined ? null : (
          <>
            <dt>{copy.summaryEnded}</dt>
            <dd>
              <time dateTime={endedAt}>{formatInstant(endedAt)}</time>
            </dd>
          </>
        )}
        {elapsedSeconds === undefined ? null : (
          <>
            <dt>{copy.summaryElapsed}</dt>
            <dd>{formatDurationClock(elapsedSeconds)}</dd>
          </>
        )}
        <dt>{copy.summaryActivities}</dt>
        <dd>{activities.map((activity) => activity.displayName).join(', ')}</dd>
      </dl>

      {/*
        Said once, about the whole workout, and only when it is true of the whole workout.
      */}
      {nothingWasRecorded ? (
        <StatusMessage
          tone="info"
          title={copy.noWorkRecordedTitle}
          body={copy.noWorkRecordedBody}
        />
      ) : null}

      {/*
        A session with no treadmill segment at all gets no cardio totals. Printing
        "Cardio target totals: 0.00 km" over a workout that was three machines and no
        treadmill is noise dressed as information.
      */}
      {!hasCardio ? null : (
        <>
          <h3 className="summary__subheading">{copy.plannedTotalsHeading}</h3>
          <dl className="detail-list">
            <dt>{copy.totalDistance}</dt>
            <dd>
              {formatMessage(copy.kilometres, {
                value: formatDistanceKilometers(summary.planned.distanceMeters),
              })}
            </dd>
            <dt>{copy.totalDuration}</dt>
            <dd>
              {summary.planned.containsDerivedDuration
                ? formatMessage(copy.targetDurationDerived, {
                    value: formatDurationClock(summary.planned.durationSeconds),
                  })
                : formatDurationClock(summary.planned.durationSeconds)}
            </dd>
          </dl>

          <h3 className="summary__subheading">{copy.actualTotalsHeading}</h3>
          {summary.actual.completedSegmentCount === 0 ? (
            /*
              "No cardio segment was marked done" is a statement about segments, and says
              so. If one holds a saved observation that was never marked done, it is said
              differently again, and the values themselves are listed below.
            */
            <StatusMessage
              tone="info"
              title={savedNotFinished.length > 0 ? copy.noneMarkedDoneTitle : copy.noActualTitle}
              body={savedNotFinished.length > 0 ? copy.noneMarkedDoneBody : copy.noActualBody}
            />
          ) : (
            /*
          A measurement nobody recorded is reported as not recorded. Summing with `?? 0`
          made a distance-only workout claim a time of 00:00 -- a number the treadmill
          never showed, contradicting the very segment it was summing.
        */
            <dl className="detail-list">
              <dt>{copy.totalDistance}</dt>
              <dd>
                {summary.actual.distanceMeters === undefined
                  ? copy.notRecorded
                  : formatMessage(copy.kilometres, {
                      value: formatDistanceKilometers(summary.actual.distanceMeters),
                    })}
              </dd>
              <dt>{copy.totalDuration}</dt>
              <dd>
                {summary.actual.durationSeconds === undefined
                  ? copy.notRecorded
                  : formatDurationClock(summary.actual.durationSeconds)}
              </dd>
              {summary.actual.averageSpeedKph === undefined ? null : (
                <>
                  <dt>{copy.averageSpeed}</dt>
                  <dd>
                    {formatMessage(copy.kilometresPerHour, {
                      value: String(roundToDecimals(summary.actual.averageSpeedKph, 2)),
                    })}
                  </dd>
                </>
              )}
            </dl>
          )}
        </>
      )}

      {!isFinalSummary || savedNotFinished.length === 0 ? null : (
        <>
          <h3 className="summary__subheading">{copy.savedNotFinishedHeading}</h3>
          <p className="summary__note">{copy.savedNotFinishedNote}</p>
          <ol className="summary__segments">
            {savedNotFinished.map((comparison) => (
              <SegmentComparisonRow
                key={comparison.segmentId}
                comparison={comparison}
                position={comparison.position + 1}
              />
            ))}
          </ol>
        </>
      )}

      {/*
        Strength belongs to the finish summary for the same reason the segment comparison
        does: while the workout is running every set is already on screen in its own card,
        directly under the machine's heading, so repeating it here would print each
        activity's name twice and each set's values twice.
      */}
      {isFinalSummary ? (
        <StrengthSummary activities={activities} strengthSets={strengthSets} />
      ) : null}

      {!isFinalSummary || comparisonRows.length === 0 ? null : (
        <>
          <h3 className="summary__subheading">{copy.segmentComparisonHeading}</h3>
          <ol className="summary__segments">
            {comparisonRows.map((comparison) => (
              <SegmentComparisonRow
                key={comparison.segmentId}
                comparison={comparison}
                position={comparison.position + 1}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function SegmentComparisonRow({
  comparison,
  position,
}: {
  comparison: SegmentComparison;
  position: number;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  const distance = (meters: number | undefined): string =>
    meters === undefined
      ? copy.notRecorded
      : formatMessage(copy.kilometres, { value: formatDistanceKilometers(meters) });
  const duration = (seconds: number | undefined): string =>
    seconds === undefined ? copy.notRecorded : formatDurationClock(seconds);
  const incline = (
    value: number | undefined,
    type: SegmentComparison['actualInclineType'],
  ): string =>
    value === undefined
      ? copy.notRecorded
      : type === 'unknown'
        ? formatMessage(copy.inclineUnconfirmed, { value: String(value) })
        : formatMessage(copy.inclineWithType, {
            value: String(value),
            type: strings.inclineType[type],
          });
  const speed = (value: number | undefined): string =>
    value === undefined
      ? copy.notRecorded
      : formatMessage(copy.kilometresPerHour, { value: String(roundToDecimals(value, 2)) });

  /*
   * An actual value is rendered because it was recorded, not because the segment was
   * marked done -- otherwise a saved 3.05 km would read as "Not recorded" on a segment
   * the user simply never finished. The heading carries the status, and only completed
   * segments reach the recorded totals, so nothing here can be read as a finished result.
   * Planned values stay in their own column and never cross into this one.
   */
  const isCompleted = comparison.status === 'completed';

  return (
    <li className="summary__segment">
      <h4 className="summary__segment-heading">
        {formatMessage(copy.segmentHeading, {
          position,
          mode: strings.cardioMode[comparison.mode],
        })}{' '}
        — {strings.segmentStatus[comparison.status]}
      </h4>
      <div className="summary__columns">
        <div>
          <h5 className="summary__column-heading">{copy.targetHeading}</h5>
          <dl className="detail-list">
            <dt>{copy.targetDistance}</dt>
            <dd>{distance(comparison.plannedDistanceMeters)}</dd>
            <dt>{copy.targetDuration}</dt>
            <dd>
              {comparison.plannedDurationSeconds === undefined
                ? copy.notRecorded
                : comparison.plannedDurationIsDerived
                  ? formatMessage(copy.targetDurationDerived, {
                      value: formatDurationClock(comparison.plannedDurationSeconds),
                    })
                  : formatDurationClock(comparison.plannedDurationSeconds)}
            </dd>
            <dt>{copy.targetSpeed}</dt>
            <dd>{speed(comparison.plannedSpeedKph)}</dd>
            <dt>{copy.targetIncline}</dt>
            <dd>{incline(comparison.plannedInclineValue, comparison.plannedInclineType)}</dd>
          </dl>
        </div>
        <div>
          <h5 className="summary__column-heading">{copy.summaryRecordedColumn}</h5>
          <dl className="detail-list">
            <dt>{copy.targetDistance}</dt>
            <dd>{distance(comparison.actualDistanceMeters)}</dd>
            <dt>{copy.actualDurationLabel}</dt>
            <dd>{duration(comparison.actualDurationSeconds)}</dd>
            {/*
              Speed is the number the sample routine uses, and it was missing
              from this comparison entirely. Both are shown, separately labelled: what the
              treadmill displayed, and what the recorded distance and time work out at.
              Neither stands in for the other.
            */}
            <dt>{copy.actualSpeedLabel}</dt>
            <dd>{speed(comparison.actualSpeedKph)}</dd>
            {/* Derived only from a finished segment's own paired numbers. */}
            {isCompleted ? (
              <>
                <dt>{copy.derivedSpeedLabel}</dt>
                <dd>{speed(comparison.derivedActualSpeedKph)}</dd>
              </>
            ) : null}
            <dt>{copy.actualInclineLabel}</dt>
            <dd>{incline(comparison.actualInclineValue, comparison.actualInclineType)}</dd>
            {/*
              Heart rate, effort, and a note are shown when they exist and are left out
              when they do not, rather than repeating "Not recorded" four more times on
              every segment of a workout where nobody wore a strap. The four fields above
              keep their explicit absence because the sample routine uses them,
              so a blank there is itself worth stating.

              Leaving these out entirely is what the defect was: all eight fields make a
              segment count as holding something recorded, so a segment could be listed
              under "saved, but never marked done" with every one of its saved values
              invisible, and no history screen yet to find them in.
            */}
            {comparison.averageHeartRateBpm === undefined ? null : (
              <>
                <dt>{copy.summaryAverageHeartRate}</dt>
                <dd>
                  {formatMessage(copy.beatsPerMinute, {
                    value: String(comparison.averageHeartRateBpm),
                  })}
                </dd>
              </>
            )}
            {comparison.maxHeartRateBpm === undefined ? null : (
              <>
                <dt>{copy.summaryMaxHeartRate}</dt>
                <dd>
                  {formatMessage(copy.beatsPerMinute, {
                    value: String(comparison.maxHeartRateBpm),
                  })}
                </dd>
              </>
            )}
            {comparison.rpe === undefined ? null : (
              <>
                <dt>{copy.summaryEffort}</dt>
                <dd>{formatMessage(copy.effortOutOfTen, { value: String(comparison.rpe) })}</dd>
              </>
            )}
            {comparison.notes === undefined ? null : (
              <>
                <dt>{copy.summaryNote}</dt>
                {/* Plain text, rendered as text. A note is never markup. */}
                <dd className="summary__segment-note">{comparison.notes}</dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </li>
  );
}

/**
 * A stored instant rendered in the reader's own locale and zone.
 *
 * The session also records the zone it started in; history is where that
 * becomes visible. Here the device's own formatting is enough and avoids inventing a
 * separate display rule for the summary.
 */
function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString();
}
