/**
 * Domain-level failures raised by pure calculation/validation helpers.
 *
 * These are thrown rather than returned so that a caller can never accidentally
 * persist a silently-degraded value (for example `NaN` grams) by ignoring a
 * result object.
 */
export type DomainErrorCode =
  | 'not_a_number'
  | 'not_finite'
  | 'negative'
  | 'not_positive'
  | 'not_integer'
  | 'unsupported_unit'
  | 'out_of_range';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly field: string;

  constructor(code: DomainErrorCode, field: string, message?: string) {
    super(message ?? `${field}: ${code}`);
    this.name = 'DomainError';
    this.code = code;
    this.field = field;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
