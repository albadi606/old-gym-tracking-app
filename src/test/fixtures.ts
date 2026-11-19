import { createFixedClock } from '../domain/clock.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import type { Machine } from '../domain/schemas.ts';

export const FIXED_NOW = '2026-08-28T05:00:00.000Z';

export const testClock = createFixedClock(FIXED_NOW);

export function testIds(): ReturnType<typeof createSequentialIdProvider> {
  return createSequentialIdProvider();
}

/**
 * A synthetic catalog record. It deliberately describes an invented "Test" machine so
 * no fixture can be mistaken for a real workout record.
 */
export function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test machine',
    aliases: [],
    category: 'other',
    primaryMuscles: [],
    secondaryMuscles: [],
    loadingKind: 'other',
    imageAssetIds: [],
    identificationConfidence: 'unverified',
    isFavorite: false,
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}
