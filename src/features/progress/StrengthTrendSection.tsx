import type { ReactNode } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import { formatDayKeyHeading, formatDurationClock } from '../../domain/format.ts';
import { roundToDecimals } from '../../domain/numbers.ts';
import type {
  StrengthTrendGroup,
  StrengthTrendPoint,
} from '../../domain/progress/strength-trends.ts';
import { fromCanonicalGrams } from '../../domain/units.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatCount, formatMessage } from '../../shared/format-message.ts';
import { TableScroll } from '../../components/TableScroll.tsx';

/**
 * Strength results, grouped only where they are genuinely comparable.
 *
 * Every group states its own identity -- exercise, machine, what the number means, and
 * which side -- because that is exactly what the reader needs in order to check a
 * comparison. A group that cannot be compared is still listed with all its sets and says
 * plainly that it carries no record: hiding it would lose the log, and comparing it would
 * claim progress that the numbers cannot support.
 *
 * A badge never appears without saying what it beat and how many earlier sets it was
 * measured against.
 */

function loadText(point: StrengthTrendPoint, kgLabel: string, unitLabels: Record<string, string>) {
  if (point.loadValue === undefined || point.loadUnit === undefined) {
    return '—';
  }
  return `${String(point.loadValue)} ${unitLabels[point.loadUnit] ?? kgLabel}`;
}

export function StrengthTrendSection({
  groups,
}: {
  groups: readonly StrengthTrendGroup[];
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.progress;
  const detailCopy = strings.pages.history.detail;

  if (groups.length === 0) {
    return (
      <section className="progress-section" aria-labelledby="progress-strength">
        <h2 className="section-heading" id="progress-strength">
          {copy.strengthHeading}
        </h2>
        <StatusMessage tone="info" title={copy.strengthEmpty} />
      </section>
    );
  }

  return (
    <section className="progress-section" aria-labelledby="progress-strength">
      <h2 className="section-heading" id="progress-strength">
        {copy.strengthHeading}
      </h2>
      <p className="card__body">{copy.strengthGroupNote}</p>

      {groups.map((group) => {
        const name = group.exerciseName ?? group.activityDisplayName;
        const identity = [
          group.machineName,
          strings.loadBasis[group.loadBasis],
          strings.bodySide[group.side],
        ]
          .filter((part): part is string => part !== undefined)
          .join(' · ');

        return (
          <section
            className="strength-group card"
            key={group.key}
            aria-label={`${name} · ${identity}`}
          >
            <h3 className="card__heading">{name}</h3>
            <p className="strength-group__identity">{identity}</p>

            {group.isComparable ? null : (
              <StatusMessage
                tone="info"
                title={copy.notComparableTitle}
                body={
                  group.exerciseId === undefined ? copy.snapshotOnlyGroup : copy.notComparableBody
                }
              />
            )}

            <dl className="fact-list">
              <div className="fact">
                <dt className="fact__label">{copy.setsLabel}</dt>
                <dd className="fact__value">{String(group.completedSetCount)}</dd>
              </div>
              {group.isComparable && group.bestPoint !== undefined ? (
                <div className="fact">
                  <dt className="fact__label">{copy.bestLabel}</dt>
                  <dd className="fact__value">
                    {loadText(group.bestPoint, strings.units.kg, strings.units)} ·{' '}
                    {formatDayKeyHeading(group.bestPoint.localDayKey)}
                  </dd>
                </div>
              ) : null}
              <div className="fact">
                <dt className="fact__label">
                  {group.volume?.side === 'both' || group.volume === undefined
                    ? copy.volumeLabel
                    : copy.volumePerSide}
                </dt>
                <dd className="fact__value">
                  {group.volume === undefined
                    ? copy.volumeUnavailable[group.volumeUnavailable ?? 'no_completed_sets']
                    : `${String(roundToDecimals(fromCanonicalGrams(group.volume.totalGrams, 'kg'), 2))} ${strings.units.kg}`}
                </dd>
              </div>
            </dl>

            {group.isComparable && !group.hasComparableSeries ? (
              <p className="card__body">{copy.singleResultNote}</p>
            ) : null}

            <TableScroll label={copy.strengthTableCaption}>
              <table className="data-table">
                <caption className="data-table__caption">{copy.strengthTableCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{copy.columnDate}</th>
                    <th scope="col">{copy.columnWorkout}</th>
                    <th scope="col">{copy.columnReps}</th>
                    <th scope="col">{copy.columnLoad}</th>
                    <th scope="col">{copy.columnNotes}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.points.map((point) => {
                    const badges: string[] = [];
                    if (point.isFirstComparableResult) {
                      badges.push(copy.baselineResult);
                    }
                    if (point.isLoadRecord) {
                      badges.push(
                        group.direction === 'lower_is_better'
                          ? copy.loadRecordAssisted
                          : copy.loadRecord,
                      );
                    }
                    if (point.isRepsAtLoadRecord) {
                      badges.push(copy.repsRecord);
                    }
                    if (point.previousBestGrams !== undefined && point.isLoadRecord) {
                      badges.push(
                        formatMessage(copy.previousBest, {
                          load: `${String(roundToDecimals(fromCanonicalGrams(point.previousBestGrams, 'kg'), 2))} ${strings.units.kg}`,
                        }),
                      );
                    }
                    if (badges.length > 0 && point.comparedSetCount > 0) {
                      badges.push(
                        formatCount(
                          copy.comparedAgainstOne,
                          copy.comparedAgainst,
                          point.comparedSetCount,
                        ),
                      );
                    }

                    return (
                      <tr key={point.setId}>
                        <td>{formatDayKeyHeading(point.localDayKey)}</td>
                        <td>{point.sessionName}</td>
                        <td>
                          {point.reps === undefined
                            ? point.durationSeconds === undefined
                              ? '—'
                              : formatDurationClock(point.durationSeconds)
                            : String(point.reps)}
                        </td>
                        <td>{loadText(point, strings.units.kg, strings.units)}</td>
                        {/* Every claim is text. A badge that only existed as a colour
                            would be invisible to half the ways this page is read. */}
                        <td>{badges.length === 0 ? '—' : badges.join(' · ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>

            {group.points.some((point) => point.isFirstComparableResult) ? (
              <p className="card__body">{copy.baselineNote}</p>
            ) : null}
            {group.completedSetCount === 0 ? (
              <p className="card__body">{detailCopy.notRecorded}</p>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}
