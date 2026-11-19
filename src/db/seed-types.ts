import type { Clock } from '../domain/clock.ts';
import type { IdProvider } from '../domain/ids.ts';
import type { GymTrackerDatabase } from './database.ts';

/**
 * The seed harness contract.
 *
 * It lives apart from `seed.ts` so that a step module can describe itself without
 * importing the harness that collects it -- otherwise every new batch would add an
 * import cycle, type-only today but a real one the moment a step needed a helper.
 */
export interface SeedContext {
  db: GymTrackerDatabase;
  clock: Clock;
  ids: IdProvider;
}

export interface SeedStep {
  key: string;
  /** The seed batch this step belongs to. A step only runs when its batch is new. */
  version: number;
  apply: (context: SeedContext) => Promise<void>;
}
