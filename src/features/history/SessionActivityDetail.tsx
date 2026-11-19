import type { ReactNode } from 'react';

import { FormField } from '../../components/FormField.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import type { ActivityCatalogState } from '../../db/history-repository.ts';
import { metersToKilometers } from '../../domain/cardio.ts';
import type { CardioSegment, SessionActivity, StrengthSet } from '../../domain/schemas.ts';
import { formatDurationClock } from '../../domain/format.ts';
import { LOAD_BASES, LOAD_UNITS, BODY_SIDES } from '../../domain/enums.ts';
import { roundToDecimals } from '../../domain/numbers.ts';
import { compareSegment } from '../../domain/workout/summary.ts';
import type { SegmentDraft, SegmentDraftErrors } from '../../domain/workout/segment-draft.ts';
import type {
  StrengthSetDraft,
  StrengthSetDraftErrors,
} from '../../domain/workout/strength-draft.ts';
import { summarizeStrengthActivity } from '../../domain/workout/strength-summary.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';

/**
 * One recorded activity, read-only or open for correction.
 *
 * The rules it keeps, all inherited from the finish summary and none of them relaxed
 * because this screen is read later:
 *
 * - **A planned value never stands in for a recorded one.** Both columns are shown, and
 *   the planned one is labelled as the plan.
 * - **A value is shown because it exists, not because a status blesses it.** A skipped or
 *   never-completed row still displays everything stored on it; the status goes in the
 *   label, not in whether the number appears.
 * - **A missing measurement stays missing.** "Not recorded" appears only for the four
 *   fields the sample routine uses; the rest are simply absent when empty, so a
 *   screen full of "Not recorded" never buries the values that do exist.
 * - **An unknown incline is never rendered as a percentage.** The type is printed beside
 *   the number, and `unknown` says so.
 */

export interface SessionActivityDetailProps {
  activity: SessionActivity;
  catalogState: ActivityCatalogState;
  segments: readonly CardioSegment[];
  sets: readonly StrengthSet[];
  correcting: boolean;
  /**
   * True while an accepted Save owns the correction draft.
   *
   * The fields render disabled so the refusal is something the user can see; the page's
   * synchronous claim is what makes it true however a change arrives.
   */
  fieldsLocked: boolean;
  segmentDrafts: Record<string, SegmentDraft>;
  setDrafts: Record<string, StrengthSetDraft>;
  segmentErrors: Record<string, SegmentDraftErrors>;
  setErrors: Record<string, StrengthSetDraftErrors>;
  onSegmentField: (segmentId: string, field: keyof SegmentDraft, value: string) => void;
  onSetField: (setId: string, field: keyof StrengthSetDraft, value: string) => void;
}

function Fact({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="fact">
      <dt className="fact__label">{label}</dt>
      <dd className="fact__value">{value}</dd>
    </div>
  );
}

export function SessionActivityDetail({
  activity,
  catalogState,
  segments,
  sets,
  correcting,
  fieldsLocked,
  segmentDrafts,
  setDrafts,
  segmentErrors,
  setErrors,
  onSegmentField,
  onSetField,
}: SessionActivityDetailProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.history.detail;
  const units = strings.units;

  const activitySegments = segments.filter((segment) => segment.sessionActivityId === activity.id);
  const activitySets = sets.filter((set) => set.sessionActivityId === activity.id);
  const strengthSummary = summarizeStrengthActivity(activity, activitySets);

  const notice =
    catalogState === 'snapshot_only'
      ? { title: copy.snapshotOnlyTitle, body: copy.snapshotOnlyBody }
      : catalogState === 'archived'
        ? { title: copy.archivedLinkTitle, body: copy.archivedLinkBody }
        : catalogState === 'missing'
          ? { title: copy.missingLinkTitle, body: copy.missingLinkBody }
          : undefined;

  return (
    <section className="activity-detail card" aria-label={activity.displayName}>
      <h3 className="card__heading">{activity.displayName}</h3>

      <dl className="fact-list">
        {activity.snapshot.machineName === undefined ? null : (
          <Fact label={strings.pages.history.machineLabel} value={activity.snapshot.machineName} />
        )}
        {activity.snapshot.exerciseName === undefined ? null : (
          <Fact
            label={strings.pages.history.exerciseLabel}
            value={activity.snapshot.exerciseName}
          />
        )}
        {activity.snapshot.setupNote === undefined ? null : (
          <Fact label={copy.setupLabel} value={activity.snapshot.setupNote} />
        )}
      </dl>

      {notice === undefined ? null : (
        /* A degraded or retired catalog link is stated plainly and never rendered as a
           link the user can follow to a record that no longer means what it did. */
        <StatusMessage tone="warning" title={notice.title} body={notice.body} />
      )}

      {activitySegments.map((segment) => {
        const comparison = compareSegment(segment);
        const draft = segmentDrafts[segment.id];
        const errors = segmentErrors[segment.id] ?? {};
        const heading = formatMessage(copy.segmentLabel, { position: segment.position + 1 });

        return (
          <article className="segment-detail" key={segment.id} aria-label={heading}>
            <h4 className="segment-detail__heading">
              {heading} · {strings.cardioMode[segment.mode]} ·{' '}
              <span className="segment-detail__status">
                {strings.segmentStatus[segment.status]}
              </span>
            </h4>

            <dl className="fact-list">
              <Fact
                label={`${copy.plannedHeading} · ${copy.distanceLabel}`}
                value={
                  comparison.plannedDistanceMeters === undefined
                    ? copy.notRecorded
                    : `${String(roundToDecimals(metersToKilometers(comparison.plannedDistanceMeters), 3))} ${units.km}`
                }
              />
              <Fact
                label={`${copy.plannedHeading} · ${copy.durationFieldLabel}`}
                value={
                  comparison.plannedDurationSeconds === undefined
                    ? copy.notRecorded
                    : formatDurationClock(comparison.plannedDurationSeconds)
                }
              />
              <Fact
                label={`${copy.plannedHeading} · ${copy.speedLabel}`}
                value={
                  comparison.plannedSpeedKph === undefined
                    ? copy.notRecorded
                    : `${String(comparison.plannedSpeedKph)} ${units.kph}`
                }
              />
              <Fact
                label={`${copy.plannedHeading} · ${copy.inclineLabel}`}
                value={
                  comparison.plannedInclineValue === undefined
                    ? copy.notRecorded
                    : `${String(comparison.plannedInclineValue)} · ${strings.inclineType[comparison.plannedInclineType]}`
                }
              />
            </dl>

            {correcting && draft !== undefined ? (
              <div className="segment-detail__form">
                <FormField label={`${copy.distanceLabel} (${units.km})`} error={errors.distanceKm}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="decimal"
                      value={draft.distanceKm}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'distanceKm', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.durationFieldLabel} error={errors.durationText}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="numeric"
                      value={draft.durationText}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'durationText', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={`${copy.speedLabel} (${units.kph})`} error={errors.speedKph}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="decimal"
                      value={draft.speedKph}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'speedKph', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.inclineLabel} error={errors.inclineValue}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="decimal"
                      value={draft.inclineValue}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'inclineValue', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.inclineTypeLabel} error={errors.inclineType}>
                  {({ id }) => (
                    <select
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      value={draft.inclineType}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'inclineType', event.target.value);
                      }}
                    >
                      <option value="percent">{strings.inclineType.percent}</option>
                      <option value="level">{strings.inclineType.level}</option>
                      <option value="unknown">{strings.inclineType.unknown}</option>
                    </select>
                  )}
                </FormField>

                <FormField label={copy.avgHeartRateLabel} error={errors.averageHeartRate}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="numeric"
                      value={draft.averageHeartRate}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'averageHeartRate', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.maxHeartRateLabel} error={errors.maxHeartRate}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="numeric"
                      value={draft.maxHeartRate}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'maxHeartRate', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.effortLabel} error={errors.rpe}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="decimal"
                      value={draft.rpe}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'rpe', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.noteLabel} error={errors.notes}>
                  {({ id, describedBy }) => (
                    <textarea
                      id={id}
                      className="input input--multiline"
                      disabled={fieldsLocked}
                      value={draft.notes}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        onSegmentField(segment.id, 'notes', event.target.value);
                      }}
                    />
                  )}
                </FormField>
              </div>
            ) : (
              <dl className="fact-list">
                <Fact
                  label={`${copy.recordedHeading} · ${copy.distanceLabel}`}
                  value={
                    comparison.actualDistanceMeters === undefined
                      ? copy.notRecorded
                      : `${String(roundToDecimals(metersToKilometers(comparison.actualDistanceMeters), 3))} ${units.km}`
                  }
                />
                <Fact
                  label={`${copy.recordedHeading} · ${copy.durationFieldLabel}`}
                  value={
                    comparison.actualDurationSeconds === undefined
                      ? copy.notRecorded
                      : formatDurationClock(comparison.actualDurationSeconds)
                  }
                />
                <Fact
                  label={`${copy.recordedHeading} · ${copy.speedLabel}`}
                  value={
                    comparison.actualSpeedKph === undefined
                      ? copy.notRecorded
                      : `${String(comparison.actualSpeedKph)} ${units.kph}`
                  }
                />
                {comparison.derivedActualSpeedKph === undefined ? null : (
                  <Fact
                    label={copy.derivedSpeedLabel}
                    value={`${String(roundToDecimals(comparison.derivedActualSpeedKph, 2))} ${units.kph}`}
                  />
                )}
                <Fact
                  label={`${copy.recordedHeading} · ${copy.inclineLabel}`}
                  value={
                    comparison.actualInclineValue === undefined
                      ? copy.notRecorded
                      : `${String(comparison.actualInclineValue)} · ${strings.inclineType[comparison.actualInclineType]}`
                  }
                />
                {comparison.averageHeartRateBpm === undefined ? null : (
                  <Fact
                    label={copy.avgHeartRateLabel}
                    value={`${String(comparison.averageHeartRateBpm)} ${units.bpm}`}
                  />
                )}
                {comparison.maxHeartRateBpm === undefined ? null : (
                  <Fact
                    label={copy.maxHeartRateLabel}
                    value={`${String(comparison.maxHeartRateBpm)} ${units.bpm}`}
                  />
                )}
                {comparison.rpe === undefined ? null : (
                  <Fact label={copy.effortLabel} value={String(comparison.rpe)} />
                )}
                {comparison.notes === undefined ? null : (
                  <Fact label={copy.noteLabel} value={comparison.notes} />
                )}
              </dl>
            )}

            {segment.status === 'skipped' ? (
              <p className="segment-detail__note">{copy.skippedNote}</p>
            ) : null}
          </article>
        );
      })}

      {strengthSummary.sets.map((line) => {
        const draft = setDrafts[line.setId];
        const errors = setErrors[line.setId] ?? {};
        const heading = formatMessage(copy.setLabel, { position: line.position + 1 });

        return (
          <article className="set-detail" key={line.setId} aria-label={heading}>
            <h4 className="set-detail__heading">
              {heading} · {strings.setType[line.setType]} ·{' '}
              <span className="set-detail__status">{strings.setStatus[line.status]}</span>
            </h4>

            {correcting && draft !== undefined ? (
              <div className="set-detail__form">
                <FormField label={copy.repsLabel} error={errors.reps}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="numeric"
                      value={draft.reps}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSetField(line.setId, 'reps', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.durationFieldLabel} error={errors.durationText}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="numeric"
                      value={draft.durationText}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSetField(line.setId, 'durationText', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.loadLabel} error={errors.loadText}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="decimal"
                      value={draft.loadText}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSetField(line.setId, 'loadText', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.unitLabel}>
                  {({ id }) => (
                    <select
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      value={draft.loadUnit}
                      onChange={(event) => {
                        onSetField(line.setId, 'loadUnit', event.target.value);
                      }}
                    >
                      {LOAD_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {strings.units[unit]}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>

                <FormField label={copy.basisLabel}>
                  {({ id }) => (
                    <select
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      value={draft.loadBasis}
                      onChange={(event) => {
                        onSetField(line.setId, 'loadBasis', event.target.value);
                      }}
                    >
                      {LOAD_BASES.map((basis) => (
                        <option key={basis} value={basis}>
                          {strings.loadBasis[basis]}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>

                <FormField label={copy.sideLabel}>
                  {({ id }) => (
                    <select
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      value={draft.side}
                      onChange={(event) => {
                        onSetField(line.setId, 'side', event.target.value);
                      }}
                    >
                      {BODY_SIDES.map((side) => (
                        <option key={side} value={side}>
                          {strings.bodySide[side]}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>

                <FormField label={copy.effortLabel} error={errors.rpe}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="decimal"
                      value={draft.rpe}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSetField(line.setId, 'rpe', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.rirLabel} error={errors.rir}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      disabled={fieldsLocked}
                      type="text"
                      inputMode="numeric"
                      value={draft.rir}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => {
                        onSetField(line.setId, 'rir', event.target.value);
                      }}
                    />
                  )}
                </FormField>

                <FormField label={copy.noteLabel}>
                  {({ id, describedBy }) => (
                    <textarea
                      id={id}
                      className="input input--multiline"
                      disabled={fieldsLocked}
                      value={draft.notes}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        onSetField(line.setId, 'notes', event.target.value);
                      }}
                    />
                  )}
                </FormField>
              </div>
            ) : (
              <dl className="fact-list">
                {line.reps === undefined ? null : (
                  <Fact label={copy.repsLabel} value={String(line.reps)} />
                )}
                {line.durationSeconds === undefined ? null : (
                  <Fact
                    label={copy.durationFieldLabel}
                    value={formatDurationClock(line.durationSeconds)}
                  />
                )}
                {line.loadValue === undefined || line.loadUnit === undefined ? null : (
                  <Fact
                    label={copy.loadLabel}
                    value={`${String(line.loadValue)} ${strings.units[line.loadUnit]}`}
                  />
                )}
                {/* What the number means travels with it. A weight with no basis beside
                    it is a number the reader cannot check. */}
                <Fact label={copy.basisLabel} value={strings.loadBasis[line.loadBasis]} />
                <Fact label={copy.sideLabel} value={strings.bodySide[line.side]} />
                {line.rpe === undefined ? null : (
                  <Fact label={copy.effortLabel} value={String(line.rpe)} />
                )}
                {line.rir === undefined ? null : (
                  <Fact label={copy.rirLabel} value={String(line.rir)} />
                )}
                {line.notes === undefined ? null : (
                  <Fact label={copy.noteLabel} value={line.notes} />
                )}
              </dl>
            )}

            {line.status === 'skipped' ? (
              <p className="set-detail__note">{copy.skippedNote}</p>
            ) : null}
          </article>
        );
      })}

      {activitySets.length > 0 ? (
        <p className="activity-detail__volume">
          {strengthSummary.volume === undefined
            ? strings.pages.progress.volumeUnavailable[
                strengthSummary.volumeUnavailable ?? 'no_completed_sets'
              ]
            : `${
                strengthSummary.volume.side === 'both' ? copy.volumeLabel : copy.volumePerSide
              }: ${String(roundToDecimals(strengthSummary.volume.totalGrams / 1000, 2))} ${units.kg}`}
        </p>
      ) : null}
    </section>
  );
}
