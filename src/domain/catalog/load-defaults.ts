import type { LoadBasis, LoadUnit } from '../enums.ts';
import type { Machine, MachineExerciseConfig } from './schemas.ts';

/**
 * What a load number means, and which default applies where.
 *
 * Three layers can express a preference, and the most specific one wins: a
 * machine-exercise configuration overrides its machine, which overrides the global
 * setting. Each layer may leave a field unset, which is why every resolver walks the
 * chain rather than reading a single merged object.
 */

export interface GlobalLoadPreferences {
  preferredLoadUnit: LoadUnit;
  loadIncrementKg: number;
  loadIncrementLb: number;
  defaultRestSeconds: number;
}

export interface LoadDefaultsInput {
  settings: GlobalLoadPreferences;
  /** Only the fields that express a default; a caller may pass a whole machine. */
  machine?: Pick<
    Machine,
    'defaultLoadUnit' | 'defaultLoadBasis' | 'incrementValue' | 'incrementUnit'
  >;
  config?: Pick<
    MachineExerciseConfig,
    | 'defaultLoadUnit'
    | 'defaultLoadBasis'
    | 'incrementValue'
    | 'incrementUnit'
    | 'defaultRestSeconds'
  >;
}

export interface ResolvedLoadDefaults {
  loadUnit: LoadUnit;
  loadBasis: LoadBasis;
  incrementValue: number;
  incrementUnit: LoadUnit;
  restSeconds: number;
  /** Which layer supplied the basis, so the UI can say why it is what it is. */
  basisSource: 'configuration' | 'machine' | 'fallback';
}

/**
 * `unknown` rather than a guess.
 *
 * If neither the configuration nor the machine states what the number means, the honest
 * answer is that we do not know. Inventing `stack_display` here would silently label a
 * plate-loaded entry as a stack reading.
 */
export const FALLBACK_LOAD_BASIS: LoadBasis = 'unknown';

export function resolveLoadUnit(input: LoadDefaultsInput): LoadUnit {
  return (
    input.config?.defaultLoadUnit ??
    input.machine?.defaultLoadUnit ??
    input.settings.preferredLoadUnit
  );
}

export function resolveLoadBasis(input: LoadDefaultsInput): {
  basis: LoadBasis;
  source: ResolvedLoadDefaults['basisSource'];
} {
  if (input.config?.defaultLoadBasis !== undefined) {
    return { basis: input.config.defaultLoadBasis, source: 'configuration' };
  }
  if (input.machine?.defaultLoadBasis !== undefined) {
    return { basis: input.machine.defaultLoadBasis, source: 'machine' };
  }
  return { basis: FALLBACK_LOAD_BASIS, source: 'fallback' };
}

/**
 * The increment step, as a value/unit pair.
 *
 * The pair is always taken from a single layer. Mixing a machine's `2.5` with a global
 * `lb` would produce a step neither layer ever described.
 */
export function resolveIncrement(input: LoadDefaultsInput): {
  value: number;
  unit: LoadUnit;
} {
  const config = input.config;
  if (config?.incrementValue !== undefined && config.incrementUnit !== undefined) {
    return { value: config.incrementValue, unit: config.incrementUnit };
  }
  const machine = input.machine;
  if (machine?.incrementValue !== undefined && machine.incrementUnit !== undefined) {
    return { value: machine.incrementValue, unit: machine.incrementUnit };
  }
  const unit = resolveLoadUnit(input);
  return {
    value: unit === 'kg' ? input.settings.loadIncrementKg : input.settings.loadIncrementLb,
    unit,
  };
}

export function resolveRestSeconds(input: LoadDefaultsInput): number {
  return input.config?.defaultRestSeconds ?? input.settings.defaultRestSeconds;
}

export function resolveLoadDefaults(input: LoadDefaultsInput): ResolvedLoadDefaults {
  const { basis, source } = resolveLoadBasis(input);
  const increment = resolveIncrement(input);
  return {
    loadUnit: resolveLoadUnit(input),
    loadBasis: basis,
    incrementValue: increment.value,
    incrementUnit: increment.unit,
    restSeconds: resolveRestSeconds(input),
    basisSource: source,
  };
}

/* -------------------------------------------------------------------------- */
/* Load-basis semantics                                                        */
/* -------------------------------------------------------------------------- */

/** A bodyweight entry carries no external number; everything else may. */
export function basisCarriesLoadValue(basis: LoadBasis): boolean {
  return basis !== 'bodyweight';
}

/**
 * Which direction counts as "more work".
 *
 * On an assisted machine the stack *removes* bodyweight, so a smaller number is the
 * harder effort. Treating it like every other basis would report progress backwards.
 */
export function basisComparisonDirection(basis: LoadBasis): 'higher_is_more' | 'lower_is_more' {
  return basis === 'assisted' ? 'lower_is_more' : 'higher_is_more';
}

/**
 * Whether two recorded loads can be put side by side at all.
 *
 * `unknown` never compares -- not even with another `unknown` -- because two numbers
 * whose meaning is unrecorded may describe completely different things.
 */
export function areBasesComparable(a: LoadBasis, b: LoadBasis): boolean {
  if (a === 'unknown' || b === 'unknown') {
    return false;
  }
  return a === b;
}
