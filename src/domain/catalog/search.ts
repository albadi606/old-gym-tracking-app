import type { LoadingKind, MuscleGroup } from '../enums.ts';
import { normalizeForSearch } from '../text.ts';
import type { Machine } from './schemas.ts';

/**
 * Pure catalog querying: matching, filtering, and ordering.
 *
 * None of it touches the database. The feature layer loads the machines it needs and
 * applies these rules, which keeps "what counts as a match" testable without a browser
 * and stops the same logic being reimplemented slightly differently in two components.
 */

export type ArchiveView = 'active' | 'archived';

export interface MachineQuery {
  /** Free text matched against the canonical name and every alias. */
  search?: string;
  muscleGroups?: readonly MuscleGroup[];
  loadingKinds?: readonly LoadingKind[];
  favoritesOnly?: boolean;
  /** The catalog shows active equipment by default; archived is a deliberate switch. */
  view?: ArchiveView;
}

/**
 * Re-exported so every existing caller of the catalog's search rules keeps working.
 * The rule itself lives in `domain/text.ts` now that history searches with it too.
 */
export { normalizeForSearch };

/** Every string a machine can be found by. */
export function machineSearchTerms(machine: Machine): string[] {
  return [machine.name, ...machine.aliases];
}

/**
 * `true` when the query text appears in the name or any alias.
 *
 * A blank query matches everything, so an empty search box is not a filter.
 */
export function matchesSearch(machine: Machine, search: string | undefined): boolean {
  const needle = normalizeForSearch(search ?? '');
  if (needle.length === 0) {
    return true;
  }
  return machineSearchTerms(machine).some((term) => normalizeForSearch(term).includes(needle));
}

/** A machine matches if it covers *any* selected group, primary or secondary. */
export function matchesMuscleGroups(
  machine: Machine,
  groups: readonly MuscleGroup[] | undefined,
): boolean {
  if (!groups || groups.length === 0) {
    return true;
  }
  const covered = new Set<MuscleGroup>([...machine.primaryMuscles, ...machine.secondaryMuscles]);
  return groups.some((group) => covered.has(group));
}

export function matchesLoadingKinds(
  machine: Machine,
  kinds: readonly LoadingKind[] | undefined,
): boolean {
  if (!kinds || kinds.length === 0) {
    return true;
  }
  return kinds.includes(machine.loadingKind);
}

export function isArchived(machine: Machine): boolean {
  return machine.archivedAt !== undefined;
}

export function matchesView(machine: Machine, view: ArchiveView = 'active'): boolean {
  return view === 'archived' ? isArchived(machine) : !isArchived(machine);
}

export function matchesQuery(machine: Machine, query: MachineQuery): boolean {
  return (
    matchesView(machine, query.view) &&
    (!query.favoritesOnly || machine.isFavorite) &&
    matchesSearch(machine, query.search) &&
    matchesMuscleGroups(machine, query.muscleGroups) &&
    matchesLoadingKinds(machine, query.loadingKinds)
  );
}

/**
 * Favourites first, then by name.
 *
 * `localeCompare` with `sensitivity: 'base'` keeps the order stable and case-insensitive
 * so "Adjustable cable station" does not sort after "Low cable row station" merely
 * because of capitalization.
 */
export function compareMachines(a: Machine, b: Machine): number {
  if (a.isFavorite !== b.isFavorite) {
    return a.isFavorite ? -1 : 1;
  }
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

export function queryMachines(machines: readonly Machine[], query: MachineQuery = {}): Machine[] {
  return machines.filter((machine) => matchesQuery(machine, query)).sort(compareMachines);
}

/** `true` when the query actually narrows the catalog, which drives the "clear" action. */
export function hasActiveFilters(query: MachineQuery): boolean {
  return (
    normalizeForSearch(query.search ?? '').length > 0 ||
    (query.muscleGroups?.length ?? 0) > 0 ||
    (query.loadingKinds?.length ?? 0) > 0 ||
    query.favoritesOnly === true
  );
}
