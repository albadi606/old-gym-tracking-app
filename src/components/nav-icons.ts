import type { ReactNode } from 'react';

import {
  HistoryIcon,
  MachinesIcon,
  ProgressIcon,
  SettingsIcon,
  TodayIcon,
  WorkoutIcon,
} from './icons.tsx';
import type { NavKey } from '../shared/navigation/routes.ts';
import type { IconProps } from './icons.tsx';

/** Maps each navigation destination to its decorative icon. */
export const NAV_ICONS: Record<NavKey, (props: IconProps) => ReactNode> = {
  today: TodayIcon,
  workout: WorkoutIcon,
  machines: MachinesIcon,
  history: HistoryIcon,
  progress: ProgressIcon,
  settings: SettingsIcon,
};
