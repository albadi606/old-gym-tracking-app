import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { FormField } from '../../components/FormField.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { type Clock, systemClock } from '../../domain/clock.ts';
import { CARDIO_MODES, INCLINE_TYPES } from '../../domain/enums.ts';
import { formatDistanceKilometers, formatDurationClock } from '../../domain/format.ts';
import { roundToDecimals } from '../../domain/numbers.ts';
import type { CardioSegment } from '../../domain/schemas.ts';
import { compareSegment } from '../../domain/workout/summary.ts';
import {
  completeCardioSegment,
  removeCardioSegment,
  reopenCardioSegment,
  skipCardioSegment,
  updateCardioSegment,
} from '../../db/workout-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useMutation } from '../../shared/useMutation.ts';
import { DraftBlockedError, type WorkoutDraftRegistry } from './draft-registry.ts';
import { useCardWrites } from './useCardWrites.ts';
import { useDraftOwnership } from './useDraftOwnership.ts';
import {
  type SegmentDraft,
  type SegmentDraftErrors,
  draftDiffersFrom,
  draftFromSegment,
  patchRecordsWork,
  validateDraft,
} from '../../domain/workout/segment-draft.ts';

/**
 * One treadmill segment: the target on the left of the user's attention, what the
 * treadmill actually showed on the right.
 *
 * The two are never the same control. Typing a recorded distance cannot touch the planned
 * distance, and the planned incline of 16 stays visible while a different actual incline
 * is entered beside it.
 *
 * The draft/save contract this card implements:
 *
 * - what is typed lives in local state and is never shown as saved;
 * - a valid change is written through to IndexedDB on blur, and by the explicit Save
 *   button for anyone who never blurs a field;
 * - the card says plainly whether it is saving, saved, or holding unsaved changes;
 * - a failed write leaves the typed values exactly where they are and offers a retry;
 * - marking the segment done writes the final values and the completion in one
 *   transaction, so a completed segment can never sit beside stale numbers.
 */

export interface SegmentCardProps {
  segment: CardioSegment;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onChanged: () => void;
  onMove: (segmentId: string, direction: -1 | 1) => void;
  isReordering: boolean;
  /**
   * Where this card publishes its draft so the terminal actions can flush it.
   *
   * Passed in rather than reached for through a context: the registry belongs to one
   * running workout, and a card that could find it on its own would also be able to
   * register itself into somebody else's.
   */
  registry: WorkoutDraftRegistry;
  /** Injected by tests so recorded timestamps are deterministic. */
  clock?: Clock;
}

export function SegmentCard({
  segment,
  position,
  isFirst,
  isLast,
  onChanged,
  onMove,
  isReordering,
  registry,
  clock = systemClock,
}: SegmentCardProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();

  const [errors, setErrors] = useState<SegmentDraftErrors>({});
  const [completeError, setCompleteError] = useState<string | undefined>(undefined);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  /**
   * Which destructive action was refused, and why.
   *
   * `recorded` is the repository refusing to destroy something already stored. `unsaved`
   * is this card refusing to *ask* it: the value in the field never reached the database,
   * so the repository would be judging an empty row and would happily delete or hide the
   * observation the user is looking at.
   */
  const [blocked, setBlocked] = useState<
    { action: 'remove' | 'skip'; reason: 'recorded' | 'unsaved' } | undefined
  >(undefined);

  /**
   * Following the stored record without overwriting what is being typed.
   *
   * A reload -- or a resume after the page was closed -- replaces the record, and the
   * draft has to follow it so the card never shows numbers the database no longer holds.
   * But a save also replaces the record, and a write takes long enough for the user to
   * have started typing in the next field, so an incoming record is adopted only while the
   * user holds no unacknowledged edit. `useDraftOwnership` records why that is tracked by
   * revision rather than by comparing values.
   */
  const clearErrors = useCallback(() => {
    setErrors({});
  }, []);
  const {
    draft,
    editDraft,
    currentRevision,
    hasUnacknowledgedEdit,
    acknowledge,
    editsLocked,
    lockEdits,
    releaseEdits,
  } = useDraftOwnership<CardioSegment, SegmentDraft>({
    record: segment,
    version: segment.updatedAt,
    build: (record) => draftFromSegment(record),
    onAdopt: clearErrors,
  });

  const mutation = useMutation(onChanged);
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  /*
   * Saves and button presses are coordinated by `useCardWrites`, shared with the strength
   * card because both hold the same durability contract and both had the same defect: a
   * second field blur carries a later revision of the draft and must not be dropped as
   * though it were a repeated tap.
   *
   * These buttons are deliberately *not* disabled while a write is in flight. Tapping one
   * while a field still has focus fires that field's blur first, which starts a save and
   * flips the pending state -- so React has already re-rendered the button as disabled by
   * the time the tap's click arrives, and the tap does nothing at all. The guard has to be
   * synchronous, never the disabled attribute; `aria-busy` reports progress instead.
   */
  const { runAction, beginAction, releaseAction, saveDraft } = useCardWrites(mutation);
  const comparison = compareSegment(segment);
  const isCompleted = segment.status === 'completed';
  /** A completed or skipped segment states an outcome; editing it means reopening first. */
  const isClosed = segment.status !== 'planned';
  /*
   * The fields stop accepting input when the record is closed, and also while an action
   * that is about to close, hide, or destroy this card is outstanding. The second half is
   * what stops an edit being typed into a row that is already on its way to being
   * completed, skipped, or removed. Lifecycle *buttons* are never disabled by a pending
   * write -- a blur starts a save before the click arrives, and disabling them there made
   * the tap itself disappear.
   */
  const fieldsLocked = isClosed || editsLocked;
  const hasUnsavedChanges = draftDiffersFrom(draft, segment);

  const messages = {
    number: strings.validation.number,
    duration: strings.validation.duration,
    rpe: strings.validation.rpe,
    heartRateOrder: strings.validation.heartRateOrder,
  };

  const modeLabel = strings.cardioMode[segment.mode];
  const label = formatMessage(copy.segmentHeading, { position, mode: modeLabel });

  /**
   * The card's current state, readable from outside a render.
   *
   * `flush` is called by whoever is finishing the workout, at a moment that has nothing
   * to do with this component's render cycle, so it cannot close over values captured
   * when the callback was created. Everything it needs is republished after every render.
   */
  const latest = useRef({ draft, segment, db, messages, mutation, isClosed });
  useEffect(() => {
    latest.current = { draft, segment, db, messages, mutation, isClosed };
  });

  /**
   * Makes this card durable, or refuses and says why.
   *
   * The write goes through the same queue as a blur save, so a flush arriving while one
   * is in flight waits for it instead of racing it. What is written is the state of the
   * form right now, which is the answer to "what should the database hold when this
   * workout closes" regardless of what has already been saved.
   */
  const flush = useCallback(async (): Promise<void> => {
    const current = latest.current;

    if (current.isClosed) {
      // Its fields are read-only; there is nothing outstanding to write.
      return;
    }
    /*
     * This claim covers this flush and no more. It is the right lifetime for a flush that
     * something other than a terminal action asked for; a Finish or Cancel needs the draft
     * for strictly longer than its own flush -- through every other card's flush and
     * through the session write -- and holds its own claim across all of it from
     * `ActiveWorkout`. Two holders, so this release cannot hand back a draft the session
     * still owns.
     */
    lockEdits('flush');
    try {
      const { errors: nextErrors, patch } = validateDraft(current.draft, current.messages);
      setErrors(nextErrors);
      if (!patch) {
        throw new DraftBlockedError('invalid', 'This segment holds a value that cannot be saved');
      }
      if (!current.db) {
        throw new DraftBlockedError('failed', 'The database is not open');
      }
      /*
       * "The draft matches the record" is not on its own a reason to skip the write. A
       * correction back to a stored value while a different write is still in flight looks
       * exactly like an untouched draft, so an unacknowledged edit is work to do as well.
       */
      if (
        !draftDiffersFrom(current.draft, current.segment) &&
        !hasUnacknowledgedEdit() &&
        !current.mutation.hasFailed
      ) {
        return;
      }
      const db = current.db;
      const segmentId = current.segment.id;
      const revision = currentRevision();
      await current.mutation.enqueueAsync(async () => {
        await updateCardioSegment(db, segmentId, patch, { clock });
        acknowledge(revision);
      });
    } finally {
      releaseEdits('flush');
    }
  }, [clock, hasUnacknowledgedEdit, currentRevision, acknowledge, lockEdits, releaseEdits]);

  /*
   * Registered with the card's edit claim, not only its flush. A terminal Finish or Cancel
   * holds every card from before the first flush until the session write settles, which is
   * strictly longer than this card's own flush -- see `draft-registry.ts`.
   */
  useEffect(
    () => registry.register(segment.id, { label, flush, lockEdits, releaseEdits }),
    [registry, segment.id, label, flush, lockEdits, releaseEdits],
  );

  /**
   * Runs a destructive or hiding action, but only once the draft is durably resolved.
   *
   * Queueing the removal behind the failed save was not enough, and the reason is worth
   * stating: the queue guarantees *order*, not *success*. `useMutation` deliberately runs
   * the next operation after the previous one settles either way -- which is right, since
   * a queue that stopped at the first failure would strand a terminal flush -- so a
   * refused save was followed by a removal that asked the repository about a row still
   * holding nothing. Its guard was working perfectly on an empty record while the value
   * the user could see was destroyed.
   *
   * So the dependency is explicit here instead. The draft is flushed first; only if that
   * succeeds does the action run, and the repository then judges what is actually stored.
   * A flush that fails leaves the row, the draft, and a visible explanation in place.
   */
  const runDestructiveAction = useCallback(
    (action: 'remove' | 'skip', operation: () => Promise<unknown>) => {
      if (!beginAction(action)) {
        return;
      }
      setBlocked(undefined);
      /*
       * Claimed before the flush, not after it. Skipping or removing is a two-step
       * operation -- make the draft durable, then close or destroy the row -- and an edit
       * arriving between the steps would be hidden or deleted although nothing had ever
       * stored it. The claim spans both steps and is released however they end.
       */
      lockEdits(action);

      void (async () => {
        try {
          try {
            await flush();
          } catch {
            // The typed value never reached the database, so nothing may be destroyed or
            // hidden on the strength of a record that does not contain it.
            setBlocked({ action, reason: 'unsaved' });
            return;
          }

          try {
            await mutation.enqueueAsync(operation);
          } catch (error) {
            if (error instanceof Error && error.name === 'CardioSegmentError') {
              setBlocked({ action, reason: 'recorded' });
              return;
            }
            throw error;
          }
        } finally {
          releaseAction(action);
          releaseEdits(action);
        }
      })();
    },
    [flush, mutation, beginAction, releaseAction, lockEdits, releaseEdits],
  );

  const setField = useCallback(
    <K extends keyof SegmentDraft>(key: K, value: SegmentDraft[K]) => {
      editDraft((current) => ({ ...current, [key]: value }));
    },
    [editDraft],
  );

  /** Writes the draft through when it parses. An invalid draft simply stays a draft. */
  const commit = useCallback(() => {
    if (!db) {
      return;
    }
    const { errors: nextErrors, patch } = validateDraft(draft, messages);
    setErrors(nextErrors);
    if (!patch) {
      return;
    }
    /*
     * An edit the user has made and no write has acknowledged still has to be written,
     * even when the draft now matches the record on screen. Returning to a stored value
     * while a different write is in flight is a newer correction, not a no-op, and
     * suppressing it here is what let the value in between survive.
     */
    if (!draftDiffersFrom(draft, segment) && !hasUnacknowledgedEdit()) {
      return;
    }
    // The draft itself names the revision for the write queue: two requests to store the
    // same fields are one request, and any difference at all is a new one that must get
    // its turn. The ownership revision is a separate, monotonic count of the user's edits,
    // because restoring a value mints the same JSON and is still a later edit.
    const revision = currentRevision();
    saveDraft(JSON.stringify(draft), async () => {
      await updateCardioSegment(db, segment.id, patch, { clock });
      acknowledge(revision);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, draft, segment, saveDraft, clock, hasUnacknowledgedEdit, currentRevision, acknowledge]);

  const complete = useCallback(() => {
    if (!db) {
      return;
    }
    const { errors: nextErrors, patch } = validateDraft(draft, messages);
    setErrors(nextErrors);
    if (!patch) {
      return;
    }
    if (!patchRecordsWork(patch)) {
      setCompleteError(copy.completeNeedsWorkError);
      return;
    }
    setCompleteError(undefined);
    // Completing stores the draft as well, so it acknowledges the revision it made durable.
    const revision = currentRevision();
    /*
     * From here this card is closing. The write stores the draft as it stands now, and the
     * row it produces disables every field, so anything typed in between would be visible,
     * unsaved, and unreachable. The claim is released when the write settles either way.
     */
    lockEdits('complete');
    runAction('complete', async () => {
      try {
        await completeCardioSegment(db, segment.id, patch, { clock });
        acknowledge(revision);
      } finally {
        releaseEdits('complete');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    db,
    draft,
    segment,
    runAction,
    clock,
    copy.completeNeedsWorkError,
    currentRevision,
    acknowledge,
  ]);

  const headingId = `segment-${segment.id}-heading`;

  return (
    <li className="segment" aria-labelledby={headingId} aria-busy={mutation.isPending}>
      <div className="segment__header">
        <h4 className="segment__heading" id={headingId}>
          {label}
        </h4>
        {/* Status is text, never colour alone. */}
        <p className="segment__status">{strings.segmentStatus[segment.status]}</p>
      </div>

      <SegmentTarget comparison={comparison} />

      <fieldset className="segment__actual">
        <legend className="segment__legend">{copy.actualHeading}</legend>

        <FormField label={copy.modeLabel}>
          {({ id }) => (
            <select
              id={id}
              className="input"
              value={draft.mode}
              onChange={(event) => {
                setField('mode', event.target.value as SegmentDraft['mode']);
              }}
              onBlur={commit}
              disabled={fieldsLocked}
            >
              {CARDIO_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {strings.cardioMode[mode]}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <div className="segment__grid">
          <FormField label={copy.actualDistanceLabel} error={errors.distanceKm}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="text"
                inputMode="decimal"
                value={draft.distanceKm}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => {
                  setField('distanceKm', event.target.value);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              />
            )}
          </FormField>

          <FormField
            label={copy.actualDurationLabel}
            hint={copy.actualDurationHint}
            error={errors.durationText}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="text"
                inputMode="numeric"
                value={draft.durationText}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => {
                  setField('durationText', event.target.value);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              />
            )}
          </FormField>

          <FormField label={copy.actualSpeedLabel} error={errors.speedKph}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="text"
                inputMode="decimal"
                value={draft.speedKph}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => {
                  setField('speedKph', event.target.value);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              />
            )}
          </FormField>

          <FormField label={copy.actualInclineLabel} error={errors.inclineValue}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="text"
                inputMode="decimal"
                value={draft.inclineValue}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => {
                  const value = event.target.value;
                  editDraft((current) => ({
                    ...current,
                    inclineValue: value,
                    // The value and its unit are one fact. Emptying the value while the
                    // unit still says "percent" leaves a claim to a measurement that no
                    // longer exists, and the record cannot hold it.
                    inclineType: value.trim().length === 0 ? 'unknown' : current.inclineType,
                  }));
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              />
            )}
          </FormField>

          <FormField label={copy.actualInclineTypeLabel}>
            {({ id }) => (
              <select
                id={id}
                className="input"
                value={draft.inclineType}
                onChange={(event) => {
                  setField('inclineType', event.target.value as SegmentDraft['inclineType']);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              >
                {INCLINE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {strings.inclineType[type]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>

        {/*
          Heart rate, effort, and notes are real data but they are not the common path:
          at the gym the treadmill shows a distance, a time, a speed, and an incline, and
          those four should be reachable without scrolling past six boxes that are
          usually left empty. The summary counts how many are filled so nothing is hidden
          without a trace.
        */}
        <details className="segment__more">
          <summary className="segment__more-summary">{copy.moreDetail}</summary>
          <div className="segment__grid">
            <FormField label={copy.averageHeartRateLabel} error={errors.averageHeartRate}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={draft.averageHeartRate}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setField('averageHeartRate', event.target.value);
                  }}
                  onBlur={commit}
                  disabled={fieldsLocked}
                />
              )}
            </FormField>

            <FormField label={copy.maxHeartRateLabel} error={errors.maxHeartRate}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={draft.maxHeartRate}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setField('maxHeartRate', event.target.value);
                  }}
                  onBlur={commit}
                  disabled={fieldsLocked}
                />
              )}
            </FormField>

            <FormField label={copy.rpeLabel} error={errors.rpe}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={draft.rpe}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setField('rpe', event.target.value);
                  }}
                  onBlur={commit}
                  disabled={fieldsLocked}
                />
              )}
            </FormField>
          </div>

          <FormField label={copy.segmentNotesLabel}>
            {({ id }) => (
              <textarea
                id={id}
                className="input input--multiline"
                rows={2}
                value={draft.notes}
                onChange={(event) => {
                  setField('notes', event.target.value);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              />
            )}
          </FormField>
        </details>

        {comparison.derivedActualSpeedKph === undefined ? null : (
          <>
            <p className="segment__derived">
              {formatMessage(copy.derivedAverageSpeed, {
                value: String(roundToDecimals(comparison.derivedActualSpeedKph, 2)),
              })}
            </p>
            <p className="segment__derived-hint">{copy.derivedAverageSpeedHint}</p>
          </>
        )}
      </fieldset>

      <p className="segment__save-state">
        {mutation.isPending
          ? copy.saveStateSaving
          : mutation.hasFailed
            ? copy.saveStateFailed
            : hasUnsavedChanges
              ? copy.saveStateUnsaved
              : copy.saveStateSaved}
      </p>

      {mutation.hasFailed ? (
        <StatusMessage
          tone="error"
          title={copy.saveStateFailed}
          body={copy.saveFailedBody}
          action={
            <button type="button" className="button button--secondary" onClick={mutation.retry}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {completeError === undefined ? null : <StatusMessage tone="error" title={completeError} />}

      {blocked === undefined ? null : (
        <StatusMessage
          tone="error"
          title={blocked.action === 'remove' ? copy.removeBlockedTitle : copy.skipBlockedTitle}
          body={
            blocked.reason === 'recorded' ? copy.recordedWorkBlockedBody : copy.unsavedBlockedBody
          }
        />
      )}

      <div
        className="segment__actions"
        role="group"
        aria-label={formatMessage(copy.segmentActionsLabel, { position })}
      >
        {isClosed ? (
          /*
           * The same control recovers from both closed states. A segment marked skipped
           * by mistake was a dead end before this: nothing could return it to planned,
           * and anything recorded on it stayed hidden behind the word "skipped".
           */
          <button
            type="button"
            className="button button--secondary"
            disabled={!db}
            aria-busy={mutation.isPending}
            onClick={() => {
              if (db) {
                runAction('reopen', () => reopenCardioSegment(db, segment.id, { clock }));
              }
            }}
          >
            {isCompleted ? copy.reopenSegment : copy.unskipSegment}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button button--secondary"
              disabled={!db}
              aria-busy={mutation.isPending}
              onClick={commit}
            >
              {copy.saveSegment}
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!db}
              aria-busy={mutation.isPending}
              onClick={complete}
            >
              {copy.completeSegment}
            </button>
          </>
        )}

        {segment.status === 'planned' ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={!db}
            onClick={() => {
              if (db) {
                runDestructiveAction('skip', () => skipCardioSegment(db, segment.id, { clock }));
              }
            }}
          >
            {copy.skipSegment}
          </button>
        ) : null}

        <button
          type="button"
          className="button button--secondary"
          disabled={isFirst || isReordering}
          onClick={() => {
            onMove(segment.id, -1);
          }}
        >
          {copy.moveUp}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={isLast || isReordering}
          onClick={() => {
            onMove(segment.id, 1);
          }}
        >
          {copy.moveDown}
        </button>

        <button
          type="button"
          className="button button--secondary"
          disabled={!db}
          onClick={() => {
            setBlocked(undefined);
            setConfirmingRemove(true);
          }}
        >
          {copy.removeSegment}
        </button>
      </div>

      <ConfirmDialog
        open={confirmingRemove}
        title={copy.removeDialogTitle}
        body={copy.removeDialogBody}
        confirmLabel={copy.removeDialogConfirm}
        cancelLabel={copy.removeDialogCancel}
        tone="danger"
        onCancel={() => {
          setConfirmingRemove(false);
        }}
        onConfirm={() => {
          setConfirmingRemove(false);
          if (db) {
            // The database refuses to delete recorded work; the card explains why rather
            // than showing a generic failure.
            runDestructiveAction('remove', () => removeCardioSegment(db, segment.id, { clock }));
          }
        }}
      />
    </li>
  );
}

/** The planned side of the segment. Read-only here: a target is not edited by doing it. */
function SegmentTarget({
  comparison,
}: {
  comparison: ReturnType<typeof compareSegment>;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  const hasTarget =
    comparison.plannedDistanceMeters !== undefined ||
    comparison.plannedDurationSeconds !== undefined ||
    comparison.plannedSpeedKph !== undefined ||
    comparison.plannedInclineValue !== undefined;

  if (!hasTarget) {
    return (
      <div className="segment__target">
        <h5 className="segment__legend">{copy.targetHeading}</h5>
        <p className="segment__target-empty">{copy.noTarget}</p>
      </div>
    );
  }

  return (
    <div className="segment__target">
      <h5 className="segment__legend">{copy.targetHeading}</h5>
      <dl className="detail-list">
        {comparison.plannedDistanceMeters === undefined ? null : (
          <>
            <dt>{copy.targetDistance}</dt>
            <dd>
              {formatMessage(copy.kilometres, {
                value: formatDistanceKilometers(comparison.plannedDistanceMeters),
              })}
            </dd>
          </>
        )}
        {comparison.plannedDurationSeconds === undefined ? null : (
          <>
            <dt>{copy.targetDuration}</dt>
            <dd>
              {comparison.plannedDurationIsDerived
                ? formatMessage(copy.targetDurationDerived, {
                    value: formatDurationClock(comparison.plannedDurationSeconds),
                  })
                : formatDurationClock(comparison.plannedDurationSeconds)}
              {comparison.plannedDurationIsDerived ? (
                <p className="segment__derived-hint">{copy.targetDurationDerivedHint}</p>
              ) : null}
            </dd>
          </>
        )}
        {comparison.plannedSpeedKph === undefined ? null : (
          <>
            <dt>{copy.targetSpeed}</dt>
            <dd>
              {formatMessage(copy.kilometresPerHour, {
                value: String(comparison.plannedSpeedKph),
              })}
            </dd>
          </>
        )}
        {comparison.plannedInclineValue === undefined ? null : (
          <>
            <dt>{copy.targetIncline}</dt>
            <dd>
              {comparison.plannedInclineType === 'unknown'
                ? formatMessage(copy.inclineUnconfirmed, {
                    value: String(comparison.plannedInclineValue),
                  })
                : formatMessage(copy.inclineWithType, {
                    value: String(comparison.plannedInclineValue),
                    type: strings.inclineType[comparison.plannedInclineType],
                  })}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
