import type { z } from 'zod';

/**
 * The one write boundary every repository parses through.
 *
 * It lives on its own so the settings and catalog repositories can be separate modules
 * without either owning the other's error type.
 */

/**
 * Raised when a record fails its runtime schema on the way into the database.
 * The message names the failing fields only; it never echoes the record itself,
 * because records carry personal workout data.
 */
export class RecordValidationError extends Error {
  readonly issues: readonly string[];

  constructor(recordKind: string, issues: readonly string[]) {
    super(`Invalid ${recordKind} record: ${issues.join('; ')}`);
    this.name = 'RecordValidationError';
    this.issues = issues;
  }
}

/**
 * Raised when a write would give two catalog records the same seed key.
 *
 * A seed key is the stable identity the seed harness looks records up by, so a second
 * record claiming it would make both seeding and lookup depend on insertion order.
 */
export class DuplicateSeedKeyError extends Error {
  readonly table: string;
  readonly seedKey: string;

  constructor(table: string, seedKey: string) {
    super(`A ${table} record with seed key "${seedKey}" already exists`);
    this.name = 'DuplicateSeedKeyError';
    this.table = table;
    this.seedKey = seedKey;
  }
}

/**
 * Why a write would have left the catalog contradicting itself.
 *
 * A machine-exercise configuration only means something if all three parts are real and
 * agree with each other. The workout flow reads setup and load defaults straight out of
 * these rows, so a contradictory row caught here is a cheap fix, while the same row
 * discovered after a month of logged sessions is a data-reconciliation problem.
 */
export type IntegrityReason =
  /** The configuration names a machine that does not exist. */
  | 'missing_machine'
  /** The configuration names an exercise that does not exist. */
  | 'missing_exercise'
  /** A configuration created alongside an exercise does not point at that exercise. */
  | 'id_mismatch'
  /** Both records exist, but the exercise does not list that machine as compatible. */
  | 'machine_not_compatible'
  /**
   * The record exists but was archived.
   *
   * Archiving is how a machine, exercise, or configuration is retired without breaking
   * the sessions that already reference it. Starting *new* work against one would revive
   * something the user deliberately put away, so it is refused rather than silently
   * un-archived.
   */
  | 'archived_reference'
  /** An edit would strip compatibility that a live configuration still depends on. */
  | 'live_configuration';

export class ReferentialIntegrityError extends Error {
  readonly reason: IntegrityReason;
  /** Configurations standing in the way, so a caller can act on them deliberately. */
  readonly configIds: readonly string[];

  constructor(reason: IntegrityReason, message: string, configIds: readonly string[] = []) {
    super(message);
    this.name = 'ReferentialIntegrityError';
    this.reason = reason;
    this.configIds = configIds;
  }
}

/** Raised when a write refers to a record that is not in the database. */
export class MissingRecordError extends Error {
  readonly table: string;

  constructor(table: string, id: string) {
    super(`No ${table} record exists with id "${id}"`);
    this.name = 'MissingRecordError';
    this.table = table;
  }
}

export function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConstraintError';
}

export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  recordKind: string,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RecordValidationError(
      recordKind,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
