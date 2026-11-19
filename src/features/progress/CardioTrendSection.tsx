import type { ReactNode } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import { metersToKilometers } from '../../domain/cardio.ts';
import { formatDayKeyHeading, formatDurationClock } from '../../domain/format.ts';
import { roundToDecimals } from '../../domain/numbers.ts';
import type { CardioTrend } from '../../domain/progress/cardio-trends.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { TableScroll } from '../../components/TableScroll.tsx';

/**
 * Recorded cardio, as a table.
 *
 * A table rather than a chart, deliberately. Every value that a line would plot is
 * present as text, in reading order, with its own units and date; it needs no pointer, no
 * hover, no colour, and no third-party library, and it does not draw a confident line
 * between two dots and a gap. If a chart is added later it has to carry exactly this much
 * information beside it, so this is the thing that has to exist either way.
 *
 * The incline readings are listed in separate groups by type. A percentage grade and a
 * machine level are different measurements that happen to be written with digits, and
 * averaging them together would produce a number describing nothing.
 */
export function CardioTrendSection({ trend }: { trend: CardioTrend }): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.progress;
  const units = strings.units;

  if (trend.completedSegmentCount === 0) {
    return (
      <section className="progress-section" aria-labelledby="progress-cardio">
        <h2 className="section-heading" id="progress-cardio">
          {copy.cardioHeading}
        </h2>
        <StatusMessage tone="info" title={copy.cardioEmpty} />
      </section>
    );
  }

  return (
    <section className="progress-section" aria-labelledby="progress-cardio">
      <h2 className="section-heading" id="progress-cardio">
        {copy.cardioHeading}
      </h2>

      {trend.hasComparableSeries ? null : (
        /* One point is a starting position, not a direction. Saying so is more useful
           than drawing a trend through a single observation. */
        <StatusMessage tone="info" title={copy.cardioBaselineOnly} />
      )}

      <dl className="fact-list">
        <div className="fact">
          <dt className="fact__label">{copy.totalDistance}</dt>
          <dd className="fact__value">
            {trend.totalDistanceMeters === undefined
              ? strings.pages.history.detail.notRecorded
              : `${String(roundToDecimals(metersToKilometers(trend.totalDistanceMeters), 3))} ${units.km}`}
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">{copy.totalTime}</dt>
          <dd className="fact__value">
            {trend.totalDurationSeconds === undefined
              ? strings.pages.history.detail.notRecorded
              : formatDurationClock(trend.totalDurationSeconds)}
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">{copy.overallAverageSpeed}</dt>
          <dd className="fact__value">
            {trend.overallAverageSpeedKph === undefined
              ? copy.overallAverageUnavailable
              : `${String(roundToDecimals(trend.overallAverageSpeedKph, 2))} ${units.kph}`}
          </dd>
        </div>
      </dl>

      <TableScroll label={copy.cardioTableCaption}>
        <table className="data-table">
          <caption className="data-table__caption">{copy.cardioTableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.columnDate}</th>
              <th scope="col">{copy.columnWorkout}</th>
              <th scope="col">{copy.columnSegment}</th>
              <th scope="col">{copy.columnDistance}</th>
              <th scope="col">{copy.columnTime}</th>
              <th scope="col">{copy.columnSpeedShown}</th>
              <th scope="col">{copy.columnSpeedDerived}</th>
              <th scope="col">{copy.columnIncline}</th>
            </tr>
          </thead>
          <tbody>
            {trend.points.map((point) => (
              <tr key={point.segmentId}>
                <td>{formatDayKeyHeading(point.localDayKey)}</td>
                <td>{point.sessionName}</td>
                <td>{strings.cardioMode[point.mode]}</td>
                <td>
                  {point.distanceMeters === undefined
                    ? '—'
                    : `${String(roundToDecimals(metersToKilometers(point.distanceMeters), 3))} ${units.km}`}
                </td>
                <td>
                  {point.durationSeconds === undefined
                    ? '—'
                    : formatDurationClock(point.durationSeconds)}
                </td>
                <td>
                  {point.displayedSpeedKph === undefined
                    ? '—'
                    : `${String(point.displayedSpeedKph)} ${units.kph}`}
                </td>
                <td>
                  {point.derivedSpeedKph === undefined
                    ? '—'
                    : `${String(roundToDecimals(point.derivedSpeedKph, 2))} ${units.kph}`}
                </td>
                <td>
                  {point.inclineValue === undefined
                    ? '—'
                    : `${String(point.inclineValue)} · ${strings.inclineType[point.inclineType]}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {trend.inclineGroups.length === 0 ? null : (
        <div className="progress-incline">
          <h3 className="section-subheading">{copy.inclineHeading}</h3>
          <p className="card__body">{copy.inclineNote}</p>
          <p className="card__body">{copy.inclineNoElevation}</p>
          {trend.inclineGroups.map((group) => (
            <section key={group.inclineType} aria-label={strings.inclineType[group.inclineType]}>
              <h4 className="section-subheading">
                {formatMessage(copy.inclineGroupHeading, {
                  type: strings.inclineType[group.inclineType],
                })}
              </h4>
              <ul className="progress-incline__list">
                {group.points.map((point) => (
                  <li key={point.segmentId}>
                    {formatDayKeyHeading(point.localDayKey)} · {point.sessionName} ·{' '}
                    {String(point.inclineValue)}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
