import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { FormField } from '../../components/FormField.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import type { ResolvedLoadDefaults } from '../../domain/catalog/load-defaults.ts';
import { basisCarriesLoadValue } from '../../domain/catalog/load-defaults.ts';
import { type Clock, systemClock } from '../../domain/clock.ts';
import { BODY_SIDES, LOAD_BASES, LOAD_UNITS, SET_TYPES } from '../../domain/enums.ts';
import { formatDurationClock } from '../../domain/format.ts';
import type { StrengthSet } from '../../domain/schemas.ts';
import { formatLoadValue } from '../../domain/units.ts';
import {
  assessStrengthResult,
  type ComparableStrengthResult,
  type StrengthComparisonContext,
  type StrengthRecord,
  selectPreviousComparableResult,
} from '../../domain/workout/strength-comparison.ts';
import { convertDraftLoadValue, stepLoadValue } from '../../domain/workout/strength-load.ts';
import { patchRecordsSetWork } from '../../domain/workout/strength-summary.ts';
import {
  hasProposedSetValues,
  hasRecordedSetObservation,
} from '../../domain/workout/strength-work.ts';
import {
  completeStrengthSet,
  removeStrengthSet,
  reopenStrengthSet,
  skipStrengthSet,
  updateStrengthSet,
} from '../../db/strength-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useMutation } from '../../shared/useMutation.ts';
import { DraftBlockedError, type WorkoutDraftRegistry } from './draft-registry.ts';
import {
  draftFromStrengthSet,
  draftWithBasis,
  type StrengthSetDraft,
  type StrengthSetDraftErrors,
  strengthDraftDiffersFrom,
  validateStrengthDraft,
} from '../../domain/workout/strength-draft.ts';
import { useCardWrites } from './useCardWrites.ts';
import { useDraftOwnership } from './useDraftOwnership.ts';

/**
 * One strength set: the numbers, what they mean, and what the same set looked like last
 * time.
 *
 * The draft contract is the one the segment card established, held to here:
 *
 * - what is typed lives in local state and is never shown as saved;
 * - a valid change is written through on blur, and by an explicit Save for anyone who
 *   never blurs a field;
 * - the card says plainly whether it is saving, saved, or holding unsaved changes;
 * - a failed write leaves the typed values exactly where they are and offers a retry;
 * - marking the set done writes the final values and the completion in one transaction,
 *   so a completed set can never sit beside stale numbers.
 *
 * Two rules are specific to a load and matter more than anything else on the screen.
 * **The unit toggle converts the draft; it never relabels it.** Switching a field showing
 * `50 lb` to kilograms shows `22.68`, and saving stores that -- `50` never silently
 * becomes fifty kilograms. **What the number means is always beside the number**, so "60,
 * per side" can never be read as "60 in total"; and on the plate-loaded press the meaning
 * starts as unknown and stays there until somebody says otherwise.
 */

export interface StrengthSetCardProps {
  set: StrengthSet;
  /** One-based, for display. */
  position: number;
  /**
   * The machine this set belongs to.
   *
   * Used only for the label the terminal barrier reports. Three machines in one workout
   * all have a "Set 1", so a message naming only the set would leave the user hunting.
   */
  activityName: string;
  /** The activity's catalog identity, which is what makes a comparison legitimate. */
  context: Omit<StrengthComparisonContext, 'loadBasis' | 'side'>;
  defaults: ResolvedLoadDefaults;
  /**
   * Completed sets from earlier workouts on this exercise, unfiltered.
   *
   * `undefined` means the history could not be read -- it is never a shorter way of saying
   * "there are none". An empty array is a genuine answer about the past; a failed read is
   * no answer at all, and reporting one as the other would let a storage failure decorate
   * an ordinary set with "first finished set on this setup" or a personal best it never
   * earned.
   */
  previousResults: readonly ComparableStrengthResult[] | undefined;
  onChanged: () => void;
  registry: WorkoutDraftRegistry;
  clock?: Clock;
}

export function StrengthSetCard({
  set,
  position,
  activityName,
  context,
  defaults,
  previousResults,
  onChanged,
  registry,
  clock = systemClock,
}: StrengthSetCardProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  const [errors, setErrors] = useState<StrengthSetDraftErrors>({});
  const [completeError, setCompleteError] = useState<string | undefined>(undefined);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  /**
   * Which destructive action was refused, and why.
   *
   * `recorded` is the repository refusing to destroy something already stored. `unsaved`
   * is this card refusing to *ask* it: the value in the field never reached the database,
   * so the repository would be judging an empty row and would happily delete or hide the
   * number the user is looking at.
   */
  const [blocked, setBlocked] = useState<
    { action: 'remove' | 'skip'; reason: 'recorded' | 'unsaved' } | undefined
  >(undefined);

  /**
   * Following the stored record without overwriting what is being typed.
   *
   * A reload replaces the record and the draft has to follow it, but so does a save -- and
   * a write takes long enough for the user to have started typing in the next field. An
   * incoming record is therefore adopted only while the user holds no unacknowledged edit;
   * `useDraftOwnership` records why that is tracked by revision rather than by comparing
   * values, and why comparing values lost a correction the user had just typed.
   *
   * The unit on screen is a presentation choice the record does not hold, so a rebuild
   * keeps the one already displayed rather than falling back to the preference again.
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
  } = useDraftOwnership<StrengthSet, StrengthSetDraft>({
    record: set,
    version: set.updatedAt,
    build: (record, current) =>
      draftFromStrengthSet(record, current?.loadUnit ?? defaults.loadUnit),
    onAdopt: clearErrors,
  });

  const mutation = useMutation(onChanged);

  /*
   * Saves and button presses go through `useCardWrites`, which keeps them apart: a second
   * blur is a later revision of the draft and must not be dropped as a duplicate, while a
   * second tap of the same button is a duplicate and must be.
   *
   * These buttons are deliberately *not* disabled while a write is in flight, for the
   * reason the segment card records: the blur fires first, flips the pending state, and
   * React re-renders the button as disabled before the tap's own click arrives. The guard
   * is synchronous inside the coordinator; `aria-busy` reports progress instead.
   */
  const { runAction, beginAction, releaseAction, saveDraft } = useCardWrites(mutation);

  const isCompleted = set.status === 'completed';
  /** A completed or skipped set states an outcome; editing it means reopening first. */
  const isClosed = set.status !== 'planned';
  /*
   * The fields stop accepting input when the record is closed, and also while an
   * action that is about to close, hide, or destroy this card is outstanding. The
   * second half is what stops an edit being typed into a row that is already on its
   * way to being completed, skipped, or removed. Lifecycle *buttons* are never
   * disabled by a pending write -- a blur starts a save before the click arrives, and
   * disabling them there made the tap itself disappear.
   */
  const fieldsLocked = isClosed || editsLocked;
  const hasUnsavedChanges = strengthDraftDiffersFrom(draft, set);

  const messages = {
    number: strings.validation.number,
    wholeNumber: strings.validation.wholeNumber,
    duration: strings.validation.duration,
    rpe: strings.validation.rpe,
    rir: strings.validation.rir,
  };

  const label = formatMessage(copy.setHeading, { position });
  /** What a blocked Finish calls this card. The heading alone repeats across machines. */
  const draftLabel = formatMessage(copy.draftSetLabel, { machine: activityName, position });

  /**
   * The card's current state, readable from outside a render.
   *
   * `flush` is called by whoever is finishing the workout, at a moment unrelated to this
   * component's render cycle, so it cannot close over values captured when the callback
   * was created. Everything it needs is republished after every render.
   */
  const latest = useRef({ draft, set, db, messages, mutation, isClosed });
  useEffect(() => {
    latest.current = { draft, set, db, messages, mutation, isClosed };
  });

  /**
   * Makes this card durable, or refuses and says why.
   *
   * The write goes through the same queue as a blur save, so a flush arriving while one is
   * in flight waits for it instead of racing it. What is written is the state of the form
   * right now, which is the answer to "what should the database hold when this workout
   * closes" regardless of what has already been saved.
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
      const { errors: nextErrors, patch } = validateStrengthDraft(current.draft, current.messages);
      setErrors(nextErrors);
      if (!patch) {
        throw new DraftBlockedError('invalid', 'This set holds a value that cannot be saved');
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
        !strengthDraftDiffersFrom(current.draft, current.set) &&
        !hasUnacknowledgedEdit() &&
        !current.mutation.hasFailed
      ) {
        return;
      }
      const db = current.db;
      const setId = current.set.id;
      const revision = currentRevision();
      await current.mutation.enqueueAsync(async () => {
        await updateStrengthSet(db, setId, patch, { clock });
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
    () => registry.register(set.id, { label: draftLabel, flush, lockEdits, releaseEdits }),
    [registry, set.id, draftLabel, flush, lockEdits, releaseEdits],
  );

  /**
   * Runs a destructive or hiding action, but only once the draft is durably resolved.
   *
   * Queueing behind a failed save is not enough: the queue guarantees *order*, not
   * *success*, so a refused save would be followed by a removal asking the repository
   * about a row that never received the value. Its guard would work perfectly on an empty
   * record while the number the user can see was destroyed. The dependency is explicit
   * here instead.
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
            setBlocked({ action, reason: 'unsaved' });
            return;
          }

          await mutation.enqueueAsync(operation);
        } catch (error) {
          /*
           * A refusal is explained in place; any other failure is already recorded by the
           * mutation, which renders the failure notice and the retry. Rethrowing here
           * would add nothing except an unhandled rejection.
           */
          if (error instanceof Error && error.name === 'StrengthSetError') {
            setBlocked({ action, reason: 'recorded' });
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
    <K extends keyof StrengthSetDraft>(key: K, value: StrengthSetDraft[K]) => {
      editDraft((current) => ({ ...current, [key]: value }));
    },
    [editDraft],
  );

  /** Writes the draft through when it parses. An invalid draft simply stays a draft. */
  const commit = useCallback(() => {
    if (!db) {
      return;
    }
    const { errors: nextErrors, patch } = validateStrengthDraft(draft, messages);
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
    if (!strengthDraftDiffersFrom(draft, set) && !hasUnacknowledgedEdit()) {
      return;
    }
    // The draft itself names the revision for the write queue: two requests to store the
    // same fields are one request, and any difference at all is a new one that must get
    // its turn. The ownership revision is a separate, monotonic count of the user's edits,
    // because restoring a value mints the same JSON and is still a later edit.
    const revision = currentRevision();
    saveDraft(JSON.stringify(draft), async () => {
      await updateStrengthSet(db, set.id, patch, { clock });
      acknowledge(revision);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, draft, set, saveDraft, clock, hasUnacknowledgedEdit, currentRevision, acknowledge]);

  const complete = useCallback(() => {
    if (!db) {
      return;
    }
    const { errors: nextErrors, patch } = validateStrengthDraft(draft, messages);
    setErrors(nextErrors);
    if (!patch) {
      return;
    }
    if (!patchRecordsSetWork(patch)) {
      setCompleteError(copy.completeSetNeedsWorkError);
      return;
    }
    setCompleteError(undefined);
    // Marking done stores the draft as well, so it acknowledges the revision it made durable.
    const revision = currentRevision();
    /*
     * From here this card is closing. The write stores the draft as it stands now, and the
     * row it produces disables every field, so anything typed in between would be visible,
     * unsaved, and unreachable. The claim is released when the write settles either way.
     */
    lockEdits('complete');
    runAction('complete', async () => {
      try {
        await completeStrengthSet(db, set.id, patch, { clock });
        acknowledge(revision);
      } finally {
        releaseEdits('complete');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    db,
    draft,
    set,
    runAction,
    clock,
    copy.completeSetNeedsWorkError,
    currentRevision,
    acknowledge,
  ]);

  /**
   * A step in the increment's own unit, converted into the one on screen.
   *
   * The chips are never labelled "harder" or "easier": on an assisted machine the minus
   * chip is the harder set, and naming the direction would be wrong half the time.
   */
  const step = useCallback(
    (direction: 1 | -1) => {
      editDraft((current) => {
        const parsed = current.loadText.trim().length === 0 ? undefined : Number(current.loadText);
        const value = parsed === undefined || !Number.isFinite(parsed) ? undefined : parsed;
        return {
          ...current,
          loadText: String(
            stepLoadValue({
              value,
              unit: current.loadUnit,
              incrementValue: defaults.incrementValue,
              incrementUnit: defaults.incrementUnit,
              direction,
            }),
          ),
        };
      });
    },
    [editDraft, defaults.incrementValue, defaults.incrementUnit],
  );

  /** Converts the visible draft. A stored completed set is untouched -- it is read-only. */
  const changeUnit = useCallback(
    (unit: StrengthSetDraft['loadUnit']) => {
      editDraft((current) => {
        if (current.loadUnit === unit) {
          return current;
        }
        const parsed = current.loadText.trim().length === 0 ? undefined : Number(current.loadText);
        const value = parsed === undefined || !Number.isFinite(parsed) ? undefined : parsed;
        const converted = convertDraftLoadValue(value, current.loadUnit, unit);
        return {
          ...current,
          loadUnit: unit,
          loadText: converted === undefined ? current.loadText : String(converted),
        };
      });
    },
    [editDraft],
  );

  const comparisonContext: StrengthComparisonContext = {
    ...context,
    loadBasis: isClosed ? set.loadBasis : draft.loadBasis,
    side: isClosed ? set.side : draft.side,
  };
  const previous =
    previousResults === undefined
      ? undefined
      : selectPreviousComparableResult(comparisonContext, previousResults);
  const assessment =
    isCompleted && previousResults !== undefined
      ? assessStrengthResult(
          comparisonContext,
          { loadGrams: set.loadGrams, reps: set.reps },
          previousResults,
        )
      : undefined;

  /**
   * The app has put numbers in these fields and nobody has answered them yet.
   *
   * A copied set opens on the previous set's values so accepting them stays one tap, but
   * the record holds no observation until the user saves or marks it done. Saying "Saved"
   * over a row like that would claim they had entered something; saying "Not saved yet"
   * would claim they had changed something. It is neither, so it says what it is.
   */
  const isProposalOnly = hasProposedSetValues(set) && !hasRecordedSetObservation(set);

  const showsLoad = basisCarriesLoadValue(draft.loadBasis);
  const headingId = `set-${set.id}-heading`;
  const incrementLabelValues = {
    value: formatLoadValue(defaults.incrementValue),
    unit: strings.units[defaults.incrementUnit],
  };

  return (
    <li className="set" aria-labelledby={headingId} aria-busy={mutation.isPending}>
      <div className="set__header">
        <h5 className="set__heading" id={headingId}>
          {label}
        </h5>
        {/* Status is text, never colour alone. */}
        <p className="set__status">{strings.setStatus[set.status]}</p>
      </div>

      {isProposalOnly ? <p className="set__proposed">{copy.setProposedNote}</p> : null}

      <PreviousResult
        previous={previous}
        basis={comparisonContext.loadBasis}
        unavailable={previousResults === undefined}
      />

      <fieldset className="set__fields">
        <legend className="set__legend">{label}</legend>

        <div className="set__grid">
          <FormField label={copy.setTypeLabel}>
            {({ id }) => (
              <select
                id={id}
                className="input"
                value={draft.setType}
                onChange={(event) => {
                  setField('setType', event.target.value as StrengthSetDraft['setType']);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              >
                {SET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {strings.setType[type]}
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
                value={draft.side}
                onChange={(event) => {
                  setField('side', event.target.value as StrengthSetDraft['side']);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              >
                {BODY_SIDES.map((side) => (
                  <option key={side} value={side}>
                    {strings.bodySide[side]}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <FormField label={copy.repsLabel} error={errors.reps}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="text"
                inputMode="numeric"
                value={draft.reps}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => {
                  setField('reps', event.target.value);
                }}
                onBlur={commit}
                disabled={fieldsLocked}
              />
            )}
          </FormField>

          <FormField
            label={copy.setDurationLabel}
            hint={copy.setDurationHint}
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
        </div>

        {/*
          What the number means sits directly above the number itself. It is not a detail
          hidden behind a disclosure: "60" on this machine can be sixty on a stack, sixty
          per side, or sixty in total, and those are three different sets.
        */}
        <FormField label={copy.loadBasisLabel}>
          {({ id }) => (
            <select
              id={id}
              className="input"
              value={draft.loadBasis}
              onChange={(event) => {
                editDraft((current) =>
                  draftWithBasis(current, event.target.value as StrengthSetDraft['loadBasis']),
                );
              }}
              onBlur={commit}
              disabled={fieldsLocked}
            >
              {LOAD_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {strings.loadBasis[basis]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <p className="set__basis-explanation">{strings.loadBasisExplanation[draft.loadBasis]}</p>

        {showsLoad ? (
          <div className="set__load">
            <FormField label={copy.loadLabel} error={errors.loadText}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={draft.loadText}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setField('loadText', event.target.value);
                  }}
                  onBlur={commit}
                  disabled={fieldsLocked}
                />
              )}
            </FormField>

            <FormField label={copy.loadUnitLabel}>
              {({ id }) => (
                <select
                  id={id}
                  className="input"
                  value={draft.loadUnit}
                  onChange={(event) => {
                    changeUnit(event.target.value as StrengthSetDraft['loadUnit']);
                  }}
                  onBlur={commit}
                  disabled={fieldsLocked}
                >
                  {LOAD_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {strings.units[unit]}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <div className="set__steps">
              <button
                type="button"
                className="button button--secondary"
                disabled={fieldsLocked}
                onClick={() => {
                  step(-1);
                }}
              >
                {formatMessage(copy.decreaseLoad, incrementLabelValues)}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={fieldsLocked}
                onClick={() => {
                  step(1);
                }}
              >
                {formatMessage(copy.increaseLoad, incrementLabelValues)}
              </button>
            </div>
          </div>
        ) : (
          <StatusMessage
            tone="info"
            title={copy.bodyweightNoLoadTitle}
            body={copy.bodyweightNoLoadBody}
          />
        )}

        <details className="set__more">
          <summary className="set__more-summary">{copy.moreSetDetail}</summary>
          <div className="set__grid">
            <FormField label={copy.setRpeLabel} error={errors.rpe}>
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

            <FormField label={copy.setRirLabel} error={errors.rir}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={draft.rir}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setField('rir', event.target.value);
                  }}
                  onBlur={commit}
                  disabled={fieldsLocked}
                />
              )}
            </FormField>
          </div>

          <FormField label={copy.setNotesLabel}>
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
      </fieldset>

      {/*
        A completed set whose history could not be read gets no badge and no "first
        result": both are claims about every earlier set, and no earlier set was legible.
      */}
      {isCompleted && previousResults === undefined ? (
        <p className="set__records-unavailable">{copy.recordsUnavailable}</p>
      ) : null}
      {assessment === undefined ? null : <RecordBadges assessment={assessment} />}

      <p className="set__save-state">
        {mutation.isPending
          ? copy.saveStateSaving
          : mutation.hasFailed
            ? copy.saveStateFailed
            : hasUnsavedChanges
              ? copy.saveStateUnsaved
              : isProposalOnly
                ? copy.saveStateProposed
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
          title={
            blocked.action === 'remove' ? copy.removeSetBlockedTitle : copy.skipSetBlockedTitle
          }
          body={
            blocked.reason === 'recorded'
              ? copy.setRecordedWorkBlockedBody
              : copy.setUnsavedBlockedBody
          }
        />
      )}

      <div
        className="set__actions"
        role="group"
        aria-label={formatMessage(copy.setActionsLabel, { position })}
      >
        {isClosed ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={!db}
            aria-busy={mutation.isPending}
            onClick={() => {
              if (db) {
                runAction('reopen', () => reopenStrengthSet(db, set.id, { clock }));
              }
            }}
          >
            {isCompleted ? copy.reopenSet : copy.unskipSet}
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
              {copy.saveSet}
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!db}
              aria-busy={mutation.isPending}
              onClick={complete}
            >
              {copy.completeSet}
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={!db}
              onClick={() => {
                if (db) {
                  runDestructiveAction('skip', () => skipStrengthSet(db, set.id, { clock }));
                }
              }}
            >
              {copy.skipSet}
            </button>
          </>
        )}

        <button
          type="button"
          className="button button--secondary"
          disabled={!db}
          onClick={() => {
            setBlocked(undefined);
            setConfirmingRemove(true);
          }}
        >
          {copy.removeSet}
        </button>
      </div>

      <ConfirmDialog
        open={confirmingRemove}
        title={copy.removeSetDialogTitle}
        body={copy.removeSetDialogBody}
        confirmLabel={copy.removeSetDialogConfirm}
        cancelLabel={copy.removeSetDialogCancel}
        tone="danger"
        onCancel={() => {
          setConfirmingRemove(false);
        }}
        onConfirm={() => {
          setConfirmingRemove(false);
          if (db) {
            // The database refuses to delete recorded work; the card explains why rather
            // than showing a generic failure.
            runDestructiveAction('remove', () => removeStrengthSet(db, set.id, { clock }));
          }
        }}
      />
    </li>
  );
}

/**
 * The last comparable result, or an honest statement that there is not one.
 *
 * It sits directly above the fields rather than on a separate analytics page, because the
 * moment it is useful is the moment the pin is being set. Its value is shown in the unit
 * it was recorded in -- converting it would put a number on screen that was never typed.
 */
function PreviousResult({
  previous,
  basis,
  unavailable,
}: {
  previous: ComparableStrengthResult | undefined;
  basis: StrengthComparisonContext['loadBasis'];
  /** The history could not be read. Distinct from "there is nothing comparable". */
  unavailable: boolean;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  return (
    <div className="set__previous">
      <h6 className="set__previous-heading">{copy.previousHeading}</h6>
      {unavailable ? (
        <p className="set__previous-empty">{copy.previousUnavailable}</p>
      ) : previous === undefined ? (
        <p className="set__previous-empty">
          {basis === 'unknown' ? copy.previousNotComparable : copy.previousNone}
        </p>
      ) : (
        <>
          <p className="set__previous-value">{describeResult(previous, strings)}</p>
          <p className="set__previous-source">
            {formatMessage(copy.previousFrom, {
              name: previous.sessionName,
              date: new Date(previous.sessionStartedAt).toLocaleDateString(),
            })}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * One result in words, in its own unit.
 *
 * The basis travels with the number everywhere it is shown, so a previous `60` can never
 * be read as a different kind of sixty than the one being typed beside it.
 */
function describeResult(
  result: ComparableStrengthResult,
  strings: ReturnType<typeof useStrings>,
): string {
  const copy = strings.pages.workout;
  const parts: string[] = [];

  if (result.loadValue !== undefined && result.loadUnit !== undefined) {
    parts.push(
      formatMessage(copy.previousLoad, {
        load: formatMessage(copy.loadWithUnit, {
          value: formatLoadValue(result.loadValue),
          unit: strings.units[result.loadUnit],
        }),
        basis: strings.loadBasis[result.loadBasis],
      }),
    );
  }
  if (result.reps !== undefined) {
    parts.push(formatMessage(copy.previousReps, { count: result.reps }));
  }
  if (result.durationSeconds !== undefined) {
    parts.push(
      formatMessage(copy.previousDuration, {
        value: formatDurationClock(result.durationSeconds),
      }),
    );
  }
  parts.push(strings.bodySide[result.side]);
  return parts.join(' · ');
}

/**
 * What this set beat, and what it was compared against.
 *
 * Every badge states the comparison it rests on. A badge that only said "personal best"
 * would be a claim the reader has no way to check, and on this data the check is the
 * point: two numbers are only comparable on the same machine, exercise, saved setup,
 * meaning, and side.
 *
 * A first result gets no badge. There is nothing to have beaten, so it is named as a first
 * result instead.
 */
function RecordBadges({
  assessment,
}: {
  assessment: ReturnType<typeof assessStrengthResult>;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  if (assessment.isFirstComparableResult) {
    return <p className="set__first-result">{copy.firstComparableResult}</p>;
  }
  if (assessment.records.length === 0) {
    return null;
  }

  return (
    <ul className="set__records">
      {assessment.records.map((record) => (
        <li key={record.kind} className="set__record">
          {/* Text, never colour alone: the title says what kind of best this is. */}
          <p className="set__record-title">
            {strings.pages.workout.recordHeading} — {recordTitle(record, copy)}
          </p>
          <p className="set__record-explanation">
            {formatMessage(
              record.comparedSetCount === 1
                ? copy.recordExplanationOne
                : copy.recordExplanationOther,
              {
                count: record.comparedSetCount,
                previous: describeResult(record.previous, strings),
              },
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function recordTitle(
  record: StrengthRecord,
  copy: ReturnType<typeof useStrings>['pages']['workout'],
): string {
  if (record.kind === 'reps_at_load') {
    return copy.recordRepsAtLoad;
  }
  return record.direction === 'lower_is_better' ? copy.recordLoadLower : copy.recordLoadHigher;
}
