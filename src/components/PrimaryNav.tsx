import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { NAV_DESTINATIONS } from '../shared/navigation/routes.ts';
import { useStrings } from '../i18n/context.ts';
import { NAV_ICONS } from './nav-icons.ts';

export type PrimaryNavVariant = 'bottom' | 'sidebar';

export interface PrimaryNavProps {
  variant: PrimaryNavVariant;
  /** The sidebar carries Settings too; the phone bottom bar keeps to five items. */
  includeSecondary: boolean;
}

/**
 * The one navigation component. Exactly one instance is rendered at a time so that
 * no destination appears twice in the accessibility tree.
 *
 * `NavLink` marks the active destination with `aria-current="page"`; the matching
 * visual treatment is a shape change and weight change, not colour alone.
 */
export function PrimaryNav({ variant, includeSecondary }: PrimaryNavProps): ReactNode {
  const strings = useStrings();
  const destinations = NAV_DESTINATIONS.filter(
    (destination) => destination.isPrimary || includeSecondary,
  );

  return (
    <nav
      className={`primary-nav primary-nav--${variant}`}
      aria-label={strings.a11y.primaryNavigation}
    >
      <ul className="primary-nav__list">
        {destinations.map((destination) => {
          const Icon = NAV_ICONS[destination.key];
          return (
            <li key={destination.key} className="primary-nav__item">
              <NavLink
                to={destination.path}
                end={destination.path === '/'}
                className={({ isActive }) =>
                  isActive ? 'primary-nav__link primary-nav__link--active' : 'primary-nav__link'
                }
              >
                <Icon />
                <span className="primary-nav__label">{destination.label(strings)}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
