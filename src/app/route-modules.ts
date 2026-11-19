/**
 * How each route's code is fetched.
 *
 * Every page is loaded on demand so that arriving at Today does not also download the
 * workout engine, the history queries, the progress projections, and the backup reader.
 * The loaders live here rather than inline in `App.tsx` for two reasons: a module that
 * exports both components and plain functions trips the react-refresh rule, and the
 * *same* loaders are what `preloadRoutes` awaits, so a test can make route arrival
 * deterministic instead of racing a chunk fetch.
 *
 * Each loader maps the page's named export onto the `default` shape `React.lazy`
 * expects. The pages keep named exports; nothing about their public surface changes.
 *
 * `NotFoundPage` is deliberately absent: it is a handful of elements, it must render
 * immediately for a mistyped address, and giving it a chunk of its own would cost a
 * network round trip to say "this page does not exist".
 */

import type { ComponentType } from 'react';

type RouteModule = { default: ComponentType };

export const loadTodayPage = (): Promise<RouteModule> =>
  import('../features/dashboard/TodayPage.tsx').then((module) => ({ default: module.TodayPage }));

export const loadWorkoutPage = (): Promise<RouteModule> =>
  import('../features/workout/WorkoutPage.tsx').then((module) => ({
    default: module.WorkoutPage,
  }));

export const loadMachinesPage = (): Promise<RouteModule> =>
  import('../features/machines/MachinesPage.tsx').then((module) => ({
    default: module.MachinesPage,
  }));

export const loadMachineDetailPage = (): Promise<RouteModule> =>
  import('../features/machines/MachineDetailPage.tsx').then((module) => ({
    default: module.MachineDetailPage,
  }));

export const loadMachineFormPage = (): Promise<RouteModule> =>
  import('../features/machines/MachineFormPage.tsx').then((module) => ({
    default: module.MachineFormPage,
  }));

export const loadHistoryPage = (): Promise<RouteModule> =>
  import('../features/history/HistoryPage.tsx').then((module) => ({
    default: module.HistoryPage,
  }));

export const loadSessionDetailPage = (): Promise<RouteModule> =>
  import('../features/history/SessionDetailPage.tsx').then((module) => ({
    default: module.SessionDetailPage,
  }));

export const loadProgressPage = (): Promise<RouteModule> =>
  import('../features/progress/ProgressPage.tsx').then((module) => ({
    default: module.ProgressPage,
  }));

export const loadSettingsPage = (): Promise<RouteModule> =>
  import('../features/settings/SettingsPage.tsx').then((module) => ({
    default: module.SettingsPage,
  }));

const ROUTE_LOADERS = [
  loadTodayPage,
  loadWorkoutPage,
  loadMachinesPage,
  loadMachineDetailPage,
  loadMachineFormPage,
  loadHistoryPage,
  loadSessionDetailPage,
  loadProgressPage,
  loadSettingsPage,
] as const;

/**
 * Resolves every route module up front.
 *
 * Test helpers await this before rendering so a component test asserts on the page
 * rather than on the loading fallback. Module imports are cached, so the `lazy`
 * factories that run afterwards resolve from memory -- the wait is real readiness, not a
 * sleep, and nothing about the production path changes.
 */
export async function preloadRoutes(): Promise<void> {
  await Promise.all(ROUTE_LOADERS.map((load) => load()));
}
