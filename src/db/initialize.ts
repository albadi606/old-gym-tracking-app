import type { Clock } from '../domain/clock.ts';
import type { IdProvider } from '../domain/ids.ts';
import { createDatabase, type GymTrackerDatabase, getDatabase } from './database.ts';
import { runSeed, type SeedResult } from './seed.ts';

export interface InitializeDatabaseOptions {
  /** Supply an isolated instance in tests; the app uses the shared singleton. */
  db?: GymTrackerDatabase;
  clock?: Clock;
  ids?: IdProvider;
}

export interface InitializedDatabase {
  db: GymTrackerDatabase;
  seed: SeedResult;
}

/**
 * Opens the database and brings its seed data up to date.
 *
 * Failures are thrown, never swallowed: the shell must be able to show an honest
 * "database unavailable" state instead of an empty app that looks like lost history.
 * Private browsing, a blocked upgrade, and exhausted storage all surface here.
 */
export async function initializeDatabase(
  options: InitializeDatabaseOptions = {},
): Promise<InitializedDatabase> {
  const db = options.db ?? getDatabase();
  await db.open();
  const seed = await runSeed(db, {
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
  });
  return { db, seed };
}

/** Creates an isolated, already-initialized database. Used by tests. */
export async function createInitializedDatabase(
  name: string,
  options: Omit<InitializeDatabaseOptions, 'db'> = {},
): Promise<InitializedDatabase> {
  return initializeDatabase({ ...options, db: createDatabase(name) });
}
