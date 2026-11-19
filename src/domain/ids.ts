/** Injectable identifier source so tests can assert exact stored records. */
export interface IdProvider {
  newId(): string;
}

export const systemIdProvider: IdProvider = {
  newId: () => crypto.randomUUID(),
};

/**
 * Deterministic UUID-shaped identifiers for tests. The values are valid v4-shaped
 * UUIDs so they pass the same boundary validation as production identifiers.
 */
export function createSequentialIdProvider(startAt = 1): IdProvider {
  let counter = startAt;
  return {
    newId(): string {
      const suffix = String(counter).padStart(12, '0');
      counter += 1;
      return `00000000-0000-4000-8000-${suffix}`;
    },
  };
}
