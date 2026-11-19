import { kilometersToMeters, metersToKilometers } from '../cardio.ts';
import type { CardioMode, InclineType } from '../enums.ts';
import { formatDurationClock, parseDurationClock } from '../format.ts';
import { roundToDecimals } from '../numbers.ts';
import type { CardioSegment } from '../schemas.ts';
import type { CardioSegmentPatch } from './patch.ts';

/**
 * The form model for one cardio segment: text in, a validated patch out.
 *
 * Every field is a string while it is being typed, because half of "20:1" is not a
 * duration and rejecting each keystroke would make the form unusable at the gym. Nothing
 * here touches the database; the draft becomes a patch only once it parses, which is what
 * keeps a partially typed number from ever replacing the last value that was stored.
 *
 * Only *actual* values and the segment type are editable here. The targets are shown
 * beside them but are not part of this draft, so recording what the treadmill did can
 * never overwrite what was planned.
 */

export interface SegmentDraft {
  mode: CardioMode;
  distanceKm: string;
  durationText: string;
  speedKph: string;
  inclineValue: string;
  inclineType: InclineType;
  averageHeartRate: string;
  maxHeartRate: string;
  rpe: string;
  notes: string;
}

export type SegmentDraftField = keyof SegmentDraft;
export type SegmentDraftErrors = Partial<Record<SegmentDraftField, string>>;

function numberToText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

export function draftFromSegment(segment: CardioSegment): SegmentDraft {
  return {
    mode: segment.mode,
    distanceKm:
      segment.actualDistanceMeters === undefined
        ? ''
        : String(roundToDecimals(metersToKilometers(segment.actualDistanceMeters), 3)),
    durationText:
      segment.actualDurationSeconds === undefined
        ? ''
        : formatDurationClock(segment.actualDurationSeconds),
    speedKph: numberToText(segment.actualSpeedKph),
    inclineValue: numberToText(segment.actualInclineValue),
    inclineType: segment.actualInclineType,
    averageHeartRate: numberToText(segment.averageHeartRateBpm),
    maxHeartRate: numberToText(segment.maxHeartRateBpm),
    rpe: numberToText(segment.rpe),
    notes: segment.notes ?? '',
  };
}

type ParsedNumber = { ok: true; value: number | undefined } | { ok: false };

function parseOptionalNumber(text: string): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  // `Number('')` is 0 and `Number('12abc')` is NaN; both are caught here rather than
  // being stored as a plausible-looking zero.
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

export interface DraftMessages {
  number: string;
  duration: string;
  rpe: string;
  heartRateOrder: string;
}

export interface ValidatedDraft {
  errors: SegmentDraftErrors;
  /** Present only when every field parsed. */
  patch: CardioSegmentPatch | undefined;
}

/**
 * Turns a draft into a patch, or into the errors that stopped it.
 *
 * The rules that are not merely "is this a number":
 *
 * - An incline value and its unit are one fact, so emptying the value takes the unit back
 *   to unconfirmed. Refusing the empty value instead -- which is what this did -- made a
 *   measured incline impossible to clear through the form at all: the input looked blank,
 *   the error explained itself, and the stored `12 / percent` never moved. A unit with no
 *   measurement is not a claim worth keeping.
 * - An average heart rate above the maximum is a contradiction, and the schema would
 *   reject it anyway; catching it here names the field the user can fix.
 * - A cleared field becomes an absent value, not a zero. "I did not note the time" and
 *   "the time was zero" are different claims.
 */
export function validateDraft(draft: SegmentDraft, messages: DraftMessages): ValidatedDraft {
  const errors: SegmentDraftErrors = {};

  const distance = parseOptionalNumber(draft.distanceKm);
  if (!distance.ok) {
    errors.distanceKm = messages.number;
  }
  const speed = parseOptionalNumber(draft.speedKph);
  if (!speed.ok) {
    errors.speedKph = messages.number;
  }
  const incline = parseOptionalNumber(draft.inclineValue);
  if (!incline.ok) {
    errors.inclineValue = messages.number;
  }
  const average = parseOptionalNumber(draft.averageHeartRate);
  if (!average.ok) {
    errors.averageHeartRate = messages.number;
  }
  const max = parseOptionalNumber(draft.maxHeartRate);
  if (!max.ok) {
    errors.maxHeartRate = messages.number;
  }

  const durationText = draft.durationText.trim();
  const duration = durationText.length === 0 ? undefined : parseDurationClock(durationText);
  if (durationText.length > 0 && duration === undefined) {
    errors.durationText = messages.duration;
  }

  const rpeText = draft.rpe.trim();
  let rpe: number | undefined;
  if (rpeText.length > 0) {
    const parsed = Number(rpeText);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10 || !Number.isInteger(parsed * 2)) {
      errors.rpe = messages.rpe;
    } else {
      rpe = parsed;
    }
  }

  if (
    average.ok &&
    max.ok &&
    average.value !== undefined &&
    max.value !== undefined &&
    average.value > max.value
  ) {
    errors.averageHeartRate = messages.heartRateOrder;
  }

  if (Object.keys(errors).length > 0) {
    return { errors, patch: undefined };
  }

  const distanceMeters =
    distance.ok && distance.value !== undefined
      ? Math.round(kilometersToMeters(distance.value))
      : undefined;
  const trimmedNotes = draft.notes.trim();
  const inclineValue = incline.ok ? incline.value : undefined;
  // The pair is normalized here as well as in the field handler, so no path -- blur,
  // Save, or completion -- can store a unit that measures nothing.
  const inclineType = inclineValue === undefined ? 'unknown' : draft.inclineType;

  /*
   * Every editable key is present, including the empty ones.
   *
   * This is the whole of the clearing fix. A patch built by omitting absent values can
   * only ever say "set this" or "say nothing about this", so emptying a field looked
   * identical to not touching it and the old value survived. The form knows the complete
   * state of every field it owns, so it states all of them: a key holding `undefined`
   * means the user emptied it, and the repository deletes the stored property.
   */
  return {
    errors,
    patch: {
      mode: draft.mode,
      actualDistanceMeters: distanceMeters,
      actualDurationSeconds: duration,
      actualSpeedKph: speed.ok ? speed.value : undefined,
      actualInclineValue: inclineValue,
      actualInclineType: inclineType,
      averageHeartRateBpm: average.ok ? average.value : undefined,
      maxHeartRateBpm: max.ok ? max.value : undefined,
      rpe,
      notes: trimmedNotes.length === 0 ? undefined : trimmedNotes,
    },
  };
}

/**
 * Whether a patch records enough to call the segment done.
 *
 * The database enforces the same rule, but checking it here lets the button explain
 * itself before the user taps it rather than after a failed write.
 */
export function patchRecordsWork(patch: CardioSegmentPatch): boolean {
  return (patch.actualDistanceMeters ?? 0) > 0 || (patch.actualDurationSeconds ?? 0) > 0;
}

/** Field-by-field comparison of two drafts. */
export function draftsAreEqual(a: SegmentDraft, b: SegmentDraft): boolean {
  return (Object.keys(a) as SegmentDraftField[]).every((key) => a[key] === b[key]);
}

/** True when the draft no longer matches what is stored, so a save is outstanding. */
export function draftDiffersFrom(draft: SegmentDraft, segment: CardioSegment): boolean {
  return !draftsAreEqual(draft, draftFromSegment(segment));
}
