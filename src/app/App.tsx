import { lazy, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';

import { NotFoundPage } from '../features/not-found/NotFoundPage.tsx';
import { AppShell } from './AppShell.tsx';
import { ROUTE_PATHS } from '../shared/navigation/routes.ts';
import {
  loadHistoryPage,
  loadMachineDetailPage,
  loadMachineFormPage,
  loadMachinesPage,
  loadProgressPage,
  loadSessionDetailPage,
  loadSettingsPage,
  loadTodayPage,
  loadWorkoutPage,
} from './route-modules.ts';

/*
 * Each destination is its own chunk. The shell, the providers, the navigation, the
 * strings, and the domain and database layers they depend on stay in the entry bundle
 * because every route needs them; the pages do not.
 *
 * The `Suspense` boundary lives inside `AppShell`, around the outlet, so the header and
 * the navigation stay on screen and keyboard focus is never thrown to the top of the
 * document while a chunk arrives.
 */
const TodayPage = lazy(loadTodayPage);
const WorkoutPage = lazy(loadWorkoutPage);
const MachinesPage = lazy(loadMachinesPage);
const MachineDetailPage = lazy(loadMachineDetailPage);
const MachineFormPage = lazy(loadMachineFormPage);
const HistoryPage = lazy(loadHistoryPage);
const SessionDetailPage = lazy(loadSessionDetailPage);
const ProgressPage = lazy(loadProgressPage);
const SettingsPage = lazy(loadSettingsPage);

export function App(): ReactNode {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path={ROUTE_PATHS.today} element={<TodayPage />} />
        <Route path={ROUTE_PATHS.workout} element={<WorkoutPage />} />
        <Route path={ROUTE_PATHS.machines} element={<MachinesPage />} />
        {/* `/machines/new` is declared before `/machines/:machineId` so the literal
            segment is never captured as an identifier. */}
        <Route path={ROUTE_PATHS.machineNew} element={<MachineFormPage />} />
        <Route path={ROUTE_PATHS.machineDetail} element={<MachineDetailPage />} />
        <Route path={ROUTE_PATHS.machineEdit} element={<MachineFormPage />} />
        <Route path={ROUTE_PATHS.history} element={<HistoryPage />} />
        <Route path={ROUTE_PATHS.historyDetail} element={<SessionDetailPage />} />
        <Route path={ROUTE_PATHS.progress} element={<ProgressPage />} />
        <Route path={ROUTE_PATHS.settings} element={<SettingsPage />} />
        {/* Eager: a mistyped address must answer immediately, not fetch a chunk first. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
