import type { LoadBasis } from './enums.ts';

/**
 * Versioned so a later change to what makes two results comparable cannot silently
 * merge history recorded under the older rule.
 */
export const COMPARISON_KEY_VERSION = 'v1';

export interface StrengthComparisonSubject {
  exerciseId: string;
  /** Absent for a free-weight/bodyweight movement performed without a catalog machine. */
  machineId?: string | undefined;
  /**
   * Present whenever attachment, pulley height, grip, or seat position changes what
   * the displayed number means.
   */
  machineExerciseConfigId?: string | undefined;
  loadBasis: LoadBasis;
}

/**
 * Two strength results may only be compared when the exercise, the physical machine,
 * the saved configuration, and the load basis all match. Displayed units are
 * deliberately *not* part of the key: kg and lb convert exactly, so they describe the
 * same load. A cable stack's `50` and a plate-loaded `50 per side` do not.
 */
export function buildStrengthComparisonKey(subject: StrengthComparisonSubject): string {
  const parts = [
    COMPARISON_KEY_VERSION,
    `ex:${subject.exerciseId}`,
    `mc:${subject.machineId ?? 'none'}`,
    `cfg:${subject.machineExerciseConfigId ?? 'none'}`,
    `basis:${subject.loadBasis}`,
  ];
  return parts.join('|');
}

export type ComparisonDirection = 'higher_is_better' | 'lower_is_better' | 'not_comparable';

/**
 * `assisted` counts down: less assistance is more work, so it must never be mixed
 * with ordinary external-load records. `bodyweight` carries no external load and
 * `unknown` carries no reliable meaning, so neither supports a load comparison.
 */
export function loadComparisonDirection(loadBasis: LoadBasis): ComparisonDirection {
  switch (loadBasis) {
    case 'assisted':
      return 'lower_is_better';
    case 'bodyweight':
    case 'unknown':
      return 'not_comparable';
    default:
      return 'higher_is_better';
  }
}

export function areStrengthResultsComparable(
  a: StrengthComparisonSubject,
  b: StrengthComparisonSubject,
): boolean {
  if (loadComparisonDirection(a.loadBasis) === 'not_comparable') {
    return false;
  }
  return buildStrengthComparisonKey(a) === buildStrengthComparisonKey(b);
}
