import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { MachinePhoto } from '../../components/MachinePhoto.tsx';
import type { Machine } from '../../domain/catalog/schemas.ts';
import type { MediaAsset } from '../../domain/media/schemas.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { machineDetailPath } from '../../shared/navigation/routes.ts';

/**
 * One machine in the catalog grid.
 *
 * The whole card is not a single link: the favourite control is a separate button, and
 * nesting an interactive control inside a link makes both unreliable for keyboard and
 * screen-reader users. Instead the name is the link and the card is its layout.
 *
 * Confidence and archived state are always text, never a colour on its own.
 */
export interface MachineCardProps {
  machine: Machine;
  assets: readonly MediaAsset[];
  onToggleFavorite: (machine: Machine) => void;
  /** A write is in flight; the control is disabled so a second tap cannot duplicate it. */
  busy?: boolean;
}

export function MachineCard({
  machine,
  assets,
  onToggleFavorite,
  busy = false,
}: MachineCardProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.machines;
  const favoriteLabel = formatMessage(machine.isFavorite ? copy.favoriteRemove : copy.favoriteAdd, {
    name: machine.name,
  });

  return (
    <li className="machine-card">
      <Link
        className="machine-card__link"
        to={machineDetailPath(machine.id)}
        aria-label={formatMessage(copy.openMachine, { name: machine.name })}
      >
        <MachinePhoto assets={assets} role="thumbnail" className="machine-card__photo" />
        <span className="machine-card__name">{machine.name}</span>
      </Link>

      <div className="machine-card__meta">
        <span className="tag">{strings.loadingKind[machine.loadingKind]}</span>
        <span className="tag tag--quiet">
          {strings.identificationConfidence[machine.identificationConfidence]}
        </span>
        {machine.archivedAt === undefined ? null : (
          <span className="tag tag--archived">{copy.archivedBadge}</span>
        )}
      </div>

      {machine.primaryMuscles.length === 0 ? null : (
        <p className="machine-card__muscles">
          {machine.primaryMuscles.map((muscle) => strings.muscleGroup[muscle]).join(', ')}
        </p>
      )}

      <button
        type="button"
        className="icon-button machine-card__favorite"
        aria-pressed={machine.isFavorite}
        aria-label={favoriteLabel}
        disabled={busy}
        onClick={() => {
          onToggleFavorite(machine);
        }}
      >
        <span aria-hidden="true">{machine.isFavorite ? '★' : '☆'}</span>
      </button>
    </li>
  );
}
