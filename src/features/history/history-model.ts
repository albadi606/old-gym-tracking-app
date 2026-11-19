import type { LoadUnit } from '../../domain/enums.ts';
import type { SessionAggregate } from '../../domain/history/session-view.ts';
import { hasRecordedObservation } from '../../domain/workout/recorded-work.ts';
import type { CardioSegment, StrengthSet } from '../../domain/schemas.ts';
import {
  type DraftMessages,
  draftFromSegment,
  draftsAreEqual,
  type SegmentDraft,
  type SegmentDraftErrors,
  validateDraft,
} from '../../domain/workout/segment-draft.ts';
import {
  draftFromRecordedSet,
  type StrengthDraftMessages,
  type StrengthSetDraft,
  type StrengthSetDraftErrors,
  strengthDraftsAreEqual,
  validateStrengthDraft,
} from '../../domain/workout/strength-draft.ts';
import { hasRecordedSetObservation } from '../../domain/workout/strength-work.ts';
import type { SessionCorrection } from '../../db/history-repository.ts';

/**
 * The correction form's model: one draft for the whole workout, one patch set out.
 *
 * A person correcting a workout changes a distance, then a note, then a weight, and then
 * presses Save once. So the draft covers the entire session and produces a single
 * correction that the repository applies in one transaction -- there is no point at which
 * half the corrections are stored and the other half are an error message.
 *
 * The draft rules are the ones the workout screen already proved, reused rather than
 * rewritten: a form that owns a field states that field every time including when it is
 * empty; a cleared field becomes absent rather than zero; an incline value and its unit
 * clear together. Those live in `domain/workout/segment-draft.ts` and
 * `domain/workout/strength-draft.ts`, which is why History can share them without
 * reaching into the workout feature.
 *
 * Only rows that actually changed are sent. A correction that names every row would make
 * every save rewrite the whole workout, and `updatedAt` would stop meaning anything.
 */

export interface SessionFactsDraft {
  name: string;
  sessionRpe: string;
  moodNote: string;
  discomfortNote: string;
  notes: string;
}

export type SessionFactsField = keyof SessionFactsDraft;
export type SessionFactsErrors = Partial<Record<SessionFactsField, string>>;

export interface CorrectionDraft {
  facts: SessionFactsDraft;
  segments: Record<string, SegmentDraft>;
  sets: Record<string, StrengthSetDraft>;
}

export interface CorrectionErrors {
  facts: SessionFactsErrors;
  segments: Record<string, SegmentDraftErrors>;
  sets: Record<string, StrengthSetDraftErrors>;
}

export interface CorrectionMessages extends DraftMessages, StrengthDraftMessages {
  nameRequired: string;
}

function numberToText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * Whether a row may be corrected at all.
 *
 * A finished row is obviously correctable. A row that was never marked done but holds
 * something the user recorded is too, because that value is real and this is the only
 * screen that can fix it. A row holding nothing but a proposal the app made is not: there
 * is nothing there to correct, and offering a form pre-filled with a suggestion would
 * invite the user to confirm work they never did.
 */
export function isCorrectableSegment(segment: CardioSegment): boolean {
  return segment.status === 'completed' || hasRecordedObservation(segment);
}

export function isCorrectableSet(set: StrengthSet): boolean {
  return set.status === 'completed' || hasRecordedSetObservation(set);
}

export function buildCorrectionDraft(
  aggregate: SessionAggregate,
  fallbackUnit: LoadUnit,
): CorrectionDraft {
  const segments: Record<string, SegmentDraft> = {};
  for (const segment of aggregate.segments) {
    if (isCorrectableSegment(segment)) {
      segments[segment.id] = draftFromSegment(segment);
    }
  }
  const sets: Record<string, StrengthSetDraft> = {};
  for (const set of aggregate.strengthSets) {
    if (isCorrectableSet(set)) {
      sets[set.id] = draftFromRecordedSet(set, fallbackUnit);
    }
  }
  return {
    facts: {
      name: aggregate.session.name,
      sessionRpe: numberToText(aggregate.session.sessionRpe),
      moodNote: aggregate.session.moodNote ?? '',
      discomfortNote: aggregate.session.discomfortNote ?? '',
      notes: aggregate.session.notes ?? '',
    },
    segments,
    sets,
  };
}

export interface ValidatedCorrection {
  errors: CorrectionErrors;
  hasErrors: boolean;
  /** Present only when everything parsed. Absent keys mean nothing changed there. */
  correction: SessionCorrection | undefined;
  /** False when the draft matches what is stored, so Save has nothing to do. */
  hasChanges: boolean;
}

function textOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function validateCorrection(
  aggregate: SessionAggregate,
  draft: CorrectionDraft,
  fallbackUnit: LoadUnit,
  messages: CorrectionMessages,
): ValidatedCorrection {
  const errors: CorrectionErrors = { facts: {}, segments: {}, sets: {} };

  const name = draft.facts.name.trim();
  if (name.length === 0) {
    errors.facts.name = messages.nameRequired;
  }

  const rpeText = draft.facts.sessionRpe.trim();
  let sessionRpe: number | undefined;
  if (rpeText.length > 0) {
    const parsed = Number(rpeText);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10 || !Number.isInteger(parsed * 2)) {
      errors.facts.sessionRpe = messages.rpe;
    } else {
      sessionRpe = parsed;
    }
  }

  const session = aggregate.session;
  const factsChanged =
    name !== session.name ||
    sessionRpe !== session.sessionRpe ||
    textOrUndefined(draft.facts.moodNote) !== session.moodNote ||
    textOrUndefined(draft.facts.discomfortNote) !== session.discomfortNote ||
    textOrUndefined(draft.facts.notes) !== session.notes;

  const segments: {
    segmentId: string;
    patch: NonNullable<ReturnType<typeof validateDraft>['patch']>;
  }[] = [];
  for (const segment of aggregate.segments) {
    const segmentDraft = draft.segments[segment.id];
    if (segmentDraft === undefined) {
      continue;
    }
    const validated = validateDraft(segmentDraft, messages);
    if (Object.keys(validated.errors).length > 0) {
      errors.segments[segment.id] = validated.errors;
      continue;
    }
    if (validated.patch !== undefined && !draftsAreEqual(segmentDraft, draftFromSegment(segment))) {
      segments.push({ segmentId: segment.id, patch: validated.patch });
    }
  }

  const sets: {
    setId: string;
    patch: NonNullable<ReturnType<typeof validateStrengthDraft>['patch']>;
  }[] = [];
  for (const set of aggregate.strengthSets) {
    const setDraft = draft.sets[set.id];
    if (setDraft === undefined) {
      continue;
    }
    const validated = validateStrengthDraft(setDraft, messages);
    if (Object.keys(validated.errors).length > 0) {
      errors.sets[set.id] = validated.errors;
      continue;
    }
    if (
      validated.patch !== undefined &&
      !strengthDraftsAreEqual(setDraft, draftFromRecordedSet(set, fallbackUnit))
    ) {
      sets.push({ setId: set.id, patch: validated.patch });
    }
  }

  const hasErrors =
    Object.keys(errors.facts).length > 0 ||
    Object.keys(errors.segments).length > 0 ||
    Object.keys(errors.sets).length > 0;
  const hasChanges = factsChanged || segments.length > 0 || sets.length > 0;

  if (hasErrors || !hasChanges) {
    return { errors, hasErrors, correction: undefined, hasChanges };
  }

  return {
    errors,
    hasErrors,
    hasChanges,
    correction: {
      ...(factsChanged
        ? {
            session: {
              name,
              sessionRpe,
              moodNote: textOrUndefined(draft.facts.moodNote),
              discomfortNote: textOrUndefined(draft.facts.discomfortNote),
              notes: textOrUndefined(draft.facts.notes),
            },
          }
        : {}),
      ...(segments.length > 0 ? { segments } : {}),
      ...(sets.length > 0 ? { sets } : {}),
    },
  };
}
