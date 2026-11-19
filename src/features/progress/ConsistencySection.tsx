import type { ReactNode } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import { formatDayKeyHeading } from '../../domain/format.ts';
import type { ConsistencySummary } from '../../domain/progress/consistency.ts';
import type { MuscleCoverageSummary } from '../../domain/progress/muscle-coverage.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatCount, formatMessage } from '../../shared/format-message.ts';

/**
 * What was logged, week by week, and which areas it covered.
 *
 * The wording here is load-bearing. These are counts of what the user recorded: there is
 * no streak, no target, no "missed" week, and no suggestion that more is better. Weeks
 * with nothing logged are not listed at all, because a week nobody wrote in is not a week
 * with zero workouts in it.
 *
 * The coverage list says out loud that it applies today's exercise-to-muscle mapping to
 * past logs. That is what makes a catalog correction able to fix history, and pretending
 * the mapping was frozen at the time would be the dishonest alternative.
 */
export function ConsistencySection({
  consistency,
  coverage,
}: {
  consistency: ConsistencySummary;
  coverage: MuscleCoverageSummary;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.progress;

  return (
    <>
      <section className="progress-section" aria-labelledby="progress-consistency">
        <h2 className="section-heading" id="progress-consistency">
          {copy.consistencyHeading}
        </h2>

        {consistency.completedSessionCount === 0 ? (
          <StatusMessage tone="info" title={copy.consistencyEmpty} />
        ) : (
          <>
            <dl className="fact-list">
              <div className="fact">
                <dt className="fact__label">{copy.workoutsLabel}</dt>
                <dd className="fact__value">
                  {formatCount(
                    copy.workoutsLoggedOne,
                    copy.workoutsLogged,
                    consistency.completedSessionCount,
                  )}
                </dd>
              </div>
              <div className="fact">
                <dt className="fact__label">{copy.activeWeeksLabel}</dt>
                <dd className="fact__value">
                  {consistency.spannedWeekCount === undefined
                    ? formatCount(
                        copy.activeWeeksOne,
                        copy.activeWeeks,
                        consistency.activeWeekCount,
                      )
                    : formatMessage(copy.activeWeeks, {
                        active: consistency.activeWeekCount,
                        spanned: consistency.spannedWeekCount,
                      })}
                </dd>
              </div>
              <div className="fact">
                <dt className="fact__label">{copy.routineLabel}</dt>
                <dd className="fact__value">
                  {consistency.fromRoutineCount === 0
                    ? copy.fromRoutineNone
                    : formatMessage(copy.fromRoutine, { count: consistency.fromRoutineCount })}
                </dd>
              </div>
            </dl>

            <ul className="progress-weeks">
              {consistency.weeks.map((week) => (
                <li key={week.weekStartDayKey}>
                  {formatMessage(copy.weekOf, {
                    day: formatDayKeyHeading(week.weekStartDayKey),
                  })}{' '}
                  · {formatMessage(copy.weekCount, { count: week.completedSessionCount })}
                </li>
              ))}
            </ul>

            <p className="card__body">{copy.consistencyNote}</p>
          </>
        )}
      </section>

      <section className="progress-section" aria-labelledby="progress-coverage">
        <h2 className="section-heading" id="progress-coverage">
          {copy.coverageHeading}
        </h2>

        {coverage.weeks.length === 0 ? (
          <StatusMessage tone="info" title={copy.coverageEmpty} />
        ) : (
          <>
            <p className="card__body">{copy.coverageLead}</p>
            <p className="card__body">{copy.coverageClassificationNote}</p>

            {coverage.weeks.map((week) => (
              <section
                className="coverage-week card"
                key={week.weekStartDayKey}
                aria-label={formatMessage(copy.weekOf, {
                  day: formatDayKeyHeading(week.weekStartDayKey),
                })}
              >
                <h3 className="card__heading">
                  {formatMessage(copy.weekOf, {
                    day: formatDayKeyHeading(week.weekStartDayKey),
                  })}
                </h3>
                <dl className="fact-list">
                  <div className="fact">
                    <dt className="fact__label">{copy.coveragePrimary}</dt>
                    <dd className="fact__value">
                      {week.primary.length === 0
                        ? copy.coverageNone
                        : week.primary.map((muscle) => strings.muscleGroup[muscle]).join(', ')}
                    </dd>
                  </div>
                  {week.secondary.length === 0 ? null : (
                    <div className="fact">
                      <dt className="fact__label">{copy.coverageSecondary}</dt>
                      <dd className="fact__value">
                        {week.secondary.map((muscle) => strings.muscleGroup[muscle]).join(', ')}
                      </dd>
                    </div>
                  )}
                  {week.unmappedActivityNames.length === 0 ? null : (
                    <div className="fact">
                      <dt className="fact__label">{copy.coverageUnmapped}</dt>
                      <dd className="fact__value">{week.unmappedActivityNames.join(', ')}</dd>
                    </div>
                  )}
                </dl>
              </section>
            ))}

            {coverage.hasUnmappedWork ? (
              <StatusMessage
                tone="info"
                title={copy.coverageUnmapped}
                body={copy.coverageUnmappedBody}
              />
            ) : null}
            <p className="card__body">{copy.coverageEditHint}</p>
          </>
        )}
      </section>
    </>
  );
}
