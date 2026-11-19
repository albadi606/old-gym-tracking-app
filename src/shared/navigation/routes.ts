import type { AppStrings } from '../../i18n/en.ts';

/**
 * Route and navigation contracts.
 *
 * These live outside `app/` on purpose. `app/` is the composition root: it wires
 * providers and renders the router. Shared UI needs to *know* the destinations without
 * depending on how the application is assembled, so the definitions sit in this neutral
 * module and `app/` imports them like everyone else. The restricted-import rules in
 * `eslint.config.js` keep that direction from silently reversing again.
 */
export const ROUTE_PATHS = {
  today: '/',
  workout: '/workout',
  machines: '/machines',
  machineNew: '/machines/new',
  machineDetail: '/machines/:machineId',
  machineEdit: '/machines/:machineId/edit',
  history: '/history',
  historyDetail: '/history/:sessionId',
  progress: '/progress',
  settings: '/settings',
} as const;

export type RouteKey = keyof typeof ROUTE_PATHS;

/**
 * The destinations that appear in navigation. The catalog's detail, new, and edit
 * routes and the history detail route are reachable *through* their list destination, so
 * they are real routes but never nav items -- keeping them out of this type is what stops
 * a bottom bar from silently growing a seventh tab.
 */
export const NAV_KEYS = [
  'today',
  'workout',
  'machines',
  'history',
  'progress',
  'settings',
] as const;
export type NavKey = (typeof NAV_KEYS)[number];

/**
 * Builders for the parameterised catalog routes.
 *
 * A machine is addressed by its stable UUID, never by name or list position: renaming
 * a machine must not break a bookmarked or reloaded URL.
 */
export function machineDetailPath(machineId: string): string {
  return `/machines/${encodeURIComponent(machineId)}`;
}

export function machineEditPath(machineId: string): string {
  return `/machines/${encodeURIComponent(machineId)}/edit`;
}

/**
 * A recorded workout is addressed by its own UUID, so a bookmarked or reloaded history
 * link keeps working after the session is renamed -- and keeps working after the machine
 * it was logged on is renamed or archived, because the URL never depended on either.
 */
export function historyDetailPath(sessionId: string): string {
  return `/history/${encodeURIComponent(sessionId)}`;
}

export interface NavDestination {
  key: NavKey;
  path: string;
  /** Reads the label out of the active locale, so navigation is never hard-coded English. */
  label: (strings: AppStrings) => string;
  /**
   * Primary destinations are the five thumb-reachable items in the phone bottom bar.
   * Settings is secondary: it lives in the header on a phone and in the sidebar on
   * a wider screen, so the bottom bar keeps comfortable target sizes.
   */
  isPrimary: boolean;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { key: 'today', path: ROUTE_PATHS.today, label: (s) => s.nav.today, isPrimary: true },
  { key: 'workout', path: ROUTE_PATHS.workout, label: (s) => s.nav.workout, isPrimary: true },
  { key: 'machines', path: ROUTE_PATHS.machines, label: (s) => s.nav.machines, isPrimary: true },
  { key: 'history', path: ROUTE_PATHS.history, label: (s) => s.nav.history, isPrimary: true },
  { key: 'progress', path: ROUTE_PATHS.progress, label: (s) => s.nav.progress, isPrimary: true },
  { key: 'settings', path: ROUTE_PATHS.settings, label: (s) => s.nav.settings, isPrimary: false },
];
