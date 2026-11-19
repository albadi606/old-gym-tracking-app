import {
  areStrengthResultsComparable,
  type ComparisonDirection,
  loadComparisonDirection,
} from '../comparison.ts';
import type { BodySide, LoadBasis, LoadUnit, SetType } from '../enums.ts';

/**
 * When two strength results describe the same thing, and when one of them is better.
 *
 * Everything here is deliberately conservative, because the cost of the two mistakes is
 * not symmetric. Refusing to compare two results that really were comparable costs a
 * badge; comparing two that were not could suggest progress when the user changed
 * machines, and there is no way for him to know that from the screen.
 *
 * So a comparison requires the exercise, the machine, the saved configuration, the load
 * basis, and the body side to be identical, and it requires the basis to mean something.
 * `unknown` never compares -- not even with another `unknown` -- and `bodyweight` carries
 * no external number to compare. `assisted` compares downwards, because the stack is
 * taking weight off you: less assistance is the harder set.
 *
 * Units are not part of the key. Kilograms and pounds convert exactly and describe the
 * same load, which is why every comparison runs on canonical grams while the screen keeps
 * showing whatever the user typed.
 */

/**
 * One completed set from an earlier workout, flattened with the identity it needs.
 *
 * The repository joins the set to its activity and session and hands the result over as
 * this shape, so nothing in this module knows what a database is and every rule below can
 * be asserted from a literal.
 */
export interface ComparableStrengthResult {
  setId: string;
  sessionId: string;
  sessionName: string;
  /** When the workout holding this set started. */
  sessionStartedAt: string;
  completedAt: string;
  exerciseId: string;
  machineId: string | undefined;
  machineExerciseConfigId: string | undefined;
  loadBasis: LoadBasis;
  side: BodySide;
  setType: SetType;
  reps: number | undefined;
  durationSeconds: number | undefined;
  /** Exactly what was typed then, kept so the screen can show it in its own unit. */
  loadValue: number | undefined;
  loadUnit: LoadUnit | undefined;
  loadGrams: number | undefined;
}

/** What the set being logged is: the identity every candidate has to match exactly. */
export interface StrengthComparisonContext {
  /** Absent on a snapshot-only activity, which can therefore never be compared. */
  exerciseId: string | undefined;
  machineId: string | undefined;
  machineExerciseConfigId: string | undefined;
  loadBasis: LoadBasis;
  side: BodySide;
}

/**
 * Whether one earlier result may stand beside this one.
 *
 * An activity whose catalog references degraded to a snapshot-only placeholder has no
 * exercise id, so it compares with nothing. That is the honest answer: the names survived
 * but the identity did not, and two rows that merely share a label are not evidence they
 * were the same movement on the same machine.
 */
export function isComparableStrengthResult(
  context: StrengthComparisonContext,
  candidate: ComparableStrengthResult,
): boolean {
  if (context.exerciseId === undefined) {
    return false;
  }
  if (context.side !== candidate.side) {
    return false;
  }
  return areStrengthResultsComparable(
    {
      exerciseId: context.exerciseId,
      machineId: context.machineId,
      machineExerciseConfigId: context.machineExerciseConfigId,
      loadBasis: context.loadBasis,
    },
    {
      exerciseId: candidate.exerciseId,
      machineId: candidate.machineId,
      machineExerciseConfigId: candidate.machineExerciseConfigId,
      loadBasis: candidate.loadBasis,
    },
  );
}

export function filterComparableStrengthResults(
  context: StrengthComparisonContext,
  candidates: readonly ComparableStrengthResult[],
): readonly ComparableStrengthResult[] {
  return candidates.filter((candidate) => isComparableStrengthResult(context, candidate));
}

/**
 * The most recent comparable result, or nothing.
 *
 * Ordered by when the set was completed, then by when its workout started, then by id --
 * the last two only so that two sets completed in the same millisecond always resolve the
 * same way rather than depending on the order the database happened to return them in.
 */
export function selectPreviousComparableResult(
  context: StrengthComparisonContext,
  candidates: readonly ComparableStrengthResult[],
): ComparableStrengthResult | undefined {
  const comparable = [...filterComparableStrengthResults(context, candidates)];
  comparable.sort((a, b) => {
    const byCompleted = Date.parse(b.completedAt) - Date.parse(a.completedAt);
    if (byCompleted !== 0) {
      return byCompleted;
    }
    const byStarted = Date.parse(b.sessionStartedAt) - Date.parse(a.sessionStartedAt);
    return byStarted !== 0 ? byStarted : b.setId.localeCompare(a.setId);
  });
  return comparable[0];
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type StrengthRecordKind =
  /** A heavier load than any comparable one before it -- or, when assisted, a lighter one. */
  | 'load'
  /** More repetitions at exactly the same canonical load. */
  | 'reps_at_load';

export interface StrengthRecord {
  kind: StrengthRecordKind;
  /** Which way "better" runs for this basis, so a badge can say what it compared. */
  direction: ComparisonDirection;
  /** The result this one beat, kept whole so the badge can quote its own value and unit. */
  previous: ComparableStrengthResult;
  /** How many earlier comparable sets were considered. */
  comparedSetCount: number;
}

export interface StrengthRecordAssessment {
  records: readonly StrengthRecord[];
  /**
   * True when nothing comparable exists yet.
   *
   * A first result is not a record. There is nothing to have beaten, and calling it one
   * would make every badge afterwards meaningless.
   */
  isFirstComparableResult: boolean;
  comparedSetCount: number;
}

/** The just-completed set, reduced to the two numbers a record can be claimed on. */
export interface StrengthResultUnderTest {
  loadGrams: number | undefined;
  reps: number | undefined;
}

const NOTHING: StrengthRecordAssessment = {
  records: [],
  isFirstComparableResult: false,
  comparedSetCount: 0,
};

/**
 * What, if anything, this set beat.
 *
 * Every gate here refuses rather than guesses:
 *
 * - a basis that does not compare produces no record at all, so `unknown` and
 *   `bodyweight` never claim one and `assisted` is judged in its own direction;
 * - a set with no canonical load claims nothing, because both record kinds are statements
 *   about a load;
 * - the baseline is the *best* comparable result, not the most recent one, so a record is
 *   a record against everything that came before it;
 * - the comparison is strict, so repeating an earlier set exactly is a repeat rather than
 *   an improvement.
 *
 * No one-rep maximum is estimated anywhere. A formula that turns eight reps into a number
 * nobody lifted is not a record.
 */
export function assessStrengthResult(
  context: StrengthComparisonContext,
  current: StrengthResultUnderTest,
  candidates: readonly ComparableStrengthResult[],
): StrengthRecordAssessment {
  const direction = loadComparisonDirection(context.loadBasis);
  if (direction === 'not_comparable') {
    return NOTHING;
  }

  const comparable = filterComparableStrengthResults(context, candidates);
  const withLoad = comparable.filter(
    (candidate): candidate is ComparableStrengthResult & { loadGrams: number } =>
      candidate.loadGrams !== undefined,
  );
  const comparedSetCount = withLoad.length;

  if (comparedSetCount === 0) {
    return { records: [], isFirstComparableResult: true, comparedSetCount: 0 };
  }
  const currentGrams = current.loadGrams;
  if (currentGrams === undefined) {
    return { records: [], isFirstComparableResult: false, comparedSetCount };
  }

  const records: StrengthRecord[] = [];

  const isBetter = (candidate: number, incumbent: number): boolean =>
    direction === 'lower_is_better' ? candidate < incumbent : candidate > incumbent;

  const bestByLoad = withLoad.reduce((best, candidate) =>
    isBetter(candidate.loadGrams, best.loadGrams) ? candidate : best,
  );
  if (isBetter(currentGrams, bestByLoad.loadGrams)) {
    records.push({ kind: 'load', direction, previous: bestByLoad, comparedSetCount });
  }

  const atSameLoad = withLoad.filter(
    (candidate): candidate is ComparableStrengthResult & { loadGrams: number; reps: number } =>
      candidate.loadGrams === currentGrams && candidate.reps !== undefined,
  );
  const currentReps = current.reps;
  if (currentReps !== undefined && atSameLoad.length > 0) {
    const bestByReps = atSameLoad.reduce((best, candidate) =>
      candidate.reps > best.reps ? candidate : best,
    );
    if (currentReps > bestByReps.reps) {
      records.push({
        kind: 'reps_at_load',
        direction: 'higher_is_better',
        previous: bestByReps,
        comparedSetCount: atSameLoad.length,
      });
    }
  }

  return { records, isFirstComparableResult: false, comparedSetCount };
}
