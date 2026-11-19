import { createDatabase, type GymTrackerDatabase } from '../db/database.ts';

let counter = 0;

/**
 * A uniquely named database per test, so no test can observe another test's records
 * and no test needs a shared reset step.
 */
export function uniqueDatabaseName(label: string): string {
  counter += 1;
  return `gym-tracker-test-${label}-${String(counter)}`;
}

export function createTestDatabase(label: string): GymTrackerDatabase {
  return createDatabase(uniqueDatabaseName(label));
}

/**
 * An opened but *unseeded* database.
 *
 * Boundary tests that count rows need a catalog they fully control. Initialization now
 * seeds four machines, so those tests open the schema without running the seed rather
 * than subtracting the seeded rows from every assertion.
 */
export async function createOpenTestDatabase(label: string): Promise<GymTrackerDatabase> {
  const db = createTestDatabase(label);
  await db.open();
  return db;
}

/** Closes and removes a test database. */
export async function destroyTestDatabase(db: GymTrackerDatabase): Promise<void> {
  db.close();
  await db.delete();
}
