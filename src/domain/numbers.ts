import { DomainError } from './errors.ts';

/** `true` only for real, finite numbers. Rejects `NaN`, `Infinity`, and non-numbers. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

export function assertFinite(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new DomainError('not_a_number', field, `${field} must be a number`);
  }
  if (!Number.isFinite(value)) {
    throw new DomainError('not_finite', field, `${field} must be finite`);
  }
  return value;
}

/** Zero is allowed. Used for loads, where `0` is a legitimate recorded value. */
export function assertNonNegativeFinite(value: unknown, field: string): number {
  const number = assertFinite(value, field);
  if (number < 0) {
    throw new DomainError('negative', field, `${field} must not be negative`);
  }
  return number;
}

/** Zero is rejected. Used for speed and for any divisor. */
export function assertPositiveFinite(value: unknown, field: string): number {
  const number = assertFinite(value, field);
  if (number <= 0) {
    throw new DomainError('not_positive', field, `${field} must be greater than zero`);
  }
  return number;
}

export function assertNonNegativeInteger(value: unknown, field: string): number {
  const number = assertNonNegativeFinite(value, field);
  if (!Number.isInteger(number)) {
    throw new DomainError('not_integer', field, `${field} must be a whole number`);
  }
  return number;
}

/**
 * Rounds for presentation only. Callers must keep the source value intact;
 * a rounded number is never written back over stored input.
 */
export function roundToDecimals(value: number, decimals: number): number {
  const safeValue = assertFinite(value, 'value');
  const safeDecimals = assertNonNegativeInteger(decimals, 'decimals');
  const factor = 10 ** safeDecimals;
  return Math.round(safeValue * factor) / factor;
}
