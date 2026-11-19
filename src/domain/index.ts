/**
 * The domain layer: pure types, calculations, and boundary validation.
 *
 * Nothing here may import React, Dexie, or any browser API beyond `crypto` and
 * `Intl`, so every rule in it stays unit-testable without a DOM or a database.
 */
export * from './asset-paths.ts';
export * from './backup/index.ts';
export * from './base64.ts';
export * from './cardio.ts';
export * from './clock.ts';
export * from './comparison.ts';
export * from './enums.ts';
export * from './errors.ts';
export * from './format.ts';
export * from './ids.ts';
export * from './numbers.ts';
export * from './optional.ts';
export * from './schemas.ts';
export * from './timezone.ts';
export * from './units.ts';
export * from './workout/lifecycle.ts';
export * from './workout/patch.ts';
export * from './workout/plan.ts';
export * from './workout/summary.ts';
