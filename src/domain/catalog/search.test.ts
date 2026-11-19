import { describe, expect, it } from 'vitest';

import { makeMachine } from '../../test/fixtures.ts';
import type { Machine } from './schemas.ts';
import {
  compareMachines,
  hasActiveFilters,
  matchesLoadingKinds,
  matchesMuscleGroups,
  matchesSearch,
  normalizeForSearch,
  queryMachines,
} from './search.ts';

const ID = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

function machine(overrides: Partial<Machine>): Machine {
  return makeMachine({ id: ID(1), ...overrides });
}

const lowRow = machine({
  id: ID(1),
  name: 'Low cable row station',
  aliases: ['Low row machine', 'Seated cable row station'],
  loadingKind: 'cable',
  primaryMuscles: ['back'],
  secondaryMuscles: ['biceps', 'forearms'],
});

const legPress = machine({
  id: ID(2),
  name: 'Selectorized seated leg press',
  aliases: ['Seated leg press', 'Horizontal leg press'],
  loadingKind: 'selectorized',
  primaryMuscles: ['quadriceps', 'glutes'],
  secondaryMuscles: ['hamstrings'],
});

const cableStation = machine({
  id: ID(3),
  name: 'Adjustable cable station',
  aliases: ['Cable machine'],
  loadingKind: 'cable',
  primaryMuscles: [],
  secondaryMuscles: [],
});

const archived = machine({
  id: ID(4),
  name: 'Old rowing machine',
  loadingKind: 'other',
  archivedAt: '2026-08-28T06:00:00.000Z',
});

const catalog = [lowRow, legPress, cableStation, archived];

describe('search normalization', () => {
  it('folds case, accents, and repeated whitespace', () => {
    expect(normalizeForSearch('  Câble   STATION ')).toBe('cable station');
  });
});

describe('matching a machine by name or alias', () => {
  it('matches the canonical name, case-insensitively', () => {
    expect(matchesSearch(lowRow, 'LOW CABLE')).toBe(true);
    expect(matchesSearch(lowRow, 'low cable')).toBe(true);
  });

  it('matches an alias the user actually says out loud', () => {
    // "Low row machine" is not the canonical name, but it is what it gets called.
    expect(matchesSearch(lowRow, 'low row machine')).toBe(true);
    expect(matchesSearch(legPress, 'horizontal')).toBe(true);
  });

  it('matches a fragment from the middle of a name', () => {
    expect(matchesSearch(legPress, 'leg')).toBe(true);
  });

  it('does not match an unrelated term', () => {
    expect(matchesSearch(legPress, 'cable')).toBe(false);
  });

  it('treats a blank or whitespace-only query as no filter at all', () => {
    expect(matchesSearch(legPress, '')).toBe(true);
    expect(matchesSearch(legPress, '   ')).toBe(true);
    expect(matchesSearch(legPress, undefined)).toBe(true);
  });
});

describe('filtering', () => {
  it('matches a muscle group in either the primary or secondary list', () => {
    expect(matchesMuscleGroups(lowRow, ['back'])).toBe(true);
    expect(matchesMuscleGroups(lowRow, ['biceps'])).toBe(true);
    expect(matchesMuscleGroups(lowRow, ['quadriceps'])).toBe(false);
  });

  it('never claims a machine works a muscle nobody recorded', () => {
    // The cable station's muscles are deliberately unrecorded: they depend on the
    // exercise. It must not appear under a muscle filter as though we knew.
    expect(matchesMuscleGroups(cableStation, ['chest'])).toBe(false);
    expect(matchesMuscleGroups(cableStation, [])).toBe(true);
    expect(matchesMuscleGroups(cableStation, undefined)).toBe(true);
  });

  it('filters by how a machine is loaded', () => {
    expect(matchesLoadingKinds(lowRow, ['cable'])).toBe(true);
    expect(matchesLoadingKinds(lowRow, ['selectorized'])).toBe(false);
    expect(matchesLoadingKinds(lowRow, ['cable', 'selectorized'])).toBe(true);
  });
});

describe('querying the catalog', () => {
  it('shows active machines by default and hides archived ones', () => {
    const names = queryMachines(catalog).map((entry) => entry.name);
    expect(names).not.toContain('Old rowing machine');
    expect(names).toHaveLength(3);
  });

  it('shows only archived machines in the archived view', () => {
    expect(queryMachines(catalog, { view: 'archived' }).map((entry) => entry.name)).toEqual([
      'Old rowing machine',
    ]);
  });

  it('combines search, muscle, loading kind, and favourites', () => {
    const favorite = { ...lowRow, isFavorite: true };
    const result = queryMachines([favorite, legPress, cableStation], {
      search: 'cable',
      loadingKinds: ['cable'],
      favoritesOnly: true,
    });
    expect(result.map((entry) => entry.name)).toEqual(['Low cable row station']);
  });

  it('returns nothing rather than guessing when a filter matches no machine', () => {
    expect(queryMachines(catalog, { search: 'treadmill' })).toEqual([]);
  });

  it('sorts favourites first, then by name regardless of capitalization', () => {
    const favorite = { ...legPress, isFavorite: true };
    const ordered = queryMachines([lowRow, favorite, cableStation]);
    expect(ordered.map((entry) => entry.name)).toEqual([
      'Selectorized seated leg press',
      'Adjustable cable station',
      'Low cable row station',
    ]);
  });

  it('compares two machines consistently', () => {
    expect(compareMachines({ ...lowRow, isFavorite: true }, legPress)).toBeLessThan(0);
    expect(compareMachines(lowRow, { ...legPress, isFavorite: true })).toBeGreaterThan(0);
  });
});

describe('knowing whether the catalog is filtered', () => {
  it('is false for an empty query and for whitespace', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ search: '   ' })).toBe(false);
    // Switching to the archived view is a different list, not a filter to clear.
    expect(hasActiveFilters({ view: 'archived' })).toBe(false);
  });

  it('is true as soon as anything narrows the list', () => {
    expect(hasActiveFilters({ search: 'row' })).toBe(true);
    expect(hasActiveFilters({ muscleGroups: ['back'] })).toBe(true);
    expect(hasActiveFilters({ loadingKinds: ['cable'] })).toBe(true);
    expect(hasActiveFilters({ favoritesOnly: true })).toBe(true);
  });
});
