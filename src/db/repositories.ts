/**
 * Compatibility barrel for the persistence API.
 *
 * The repositories group together related records: settings
 * and schema bookkeeping in `settings-repository.ts`, the catalog in
 * `catalog-repository.ts`, workouts in `workout-repository.ts`, and the shared validation
 * boundary in `record-validation.ts`. This file keeps the original import
 * path working so nothing had to change in the same commit as the extraction, and it is
 * the place to look for what persistence offers as a whole.
 *
 * New code should import the narrower module directly.
 */
export * from './record-validation.ts';
export * from './settings-repository.ts';
export * from './catalog-repository.ts';
export * from './workout-repository.ts';
