import type { ReactNode } from 'react';

/**
 * Navigation icons.
 *
 * Every icon is decorative: the label beside it carries the meaning, so each is
 * `aria-hidden` and no icon is ever the only cue for a destination or a state.
 */
export interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      className={className ?? 'icon'}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function TodayIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </Svg>
  );
}

export function WorkoutIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 9v6M8 7v10M16 7v10M20 9v6M8 12h8" />
    </Svg>
  );
}

export function MachinesIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="m3 14 5-4 4 3 3-2 6 4" />
      <circle cx="9" cy="8.5" r="1.5" />
    </Svg>
  );
}

export function HistoryIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

export function ProgressIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 19h16" />
      <path d="m5 15 4-5 4 3 6-8" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2m0 14v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M3 12h2m14 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}
