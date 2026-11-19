import type { ActivityKind, CardioMode, InclineType, LoadBasis } from '../domain/enums.ts';

/**
 * An editable sample workout for a new installation.
 *
 * Like the catalog seed, this is *data*, not interface copy. Every field below becomes an
 * editable database record the moment the seed runs -- the template can be renamed,
 * reordered, retargeted, or archived, and re-initialization will not undo any of it.
 *
 * Two things are deliberately absent.
 *
 * **No durations are stored.** The two treadmill targets record a distance and a speed;
 * the target time is calculated from them for display. Storing that duration as a result would
 * make a suggestion look like a measurement, and the treadmill has not agreed to run at
 * one fixed speed.
 *
 * **No completed work exists.** The strength items carry a load basis and nothing else:
 * no sets, no reps, no loads, no results. Seeding a plausible-looking history would be
 * indistinguishable from a real workout record.
 */

export interface SeedCardioTargetDefinition {
  mode: CardioMode;
  plannedDistanceMeters: number;
  plannedSpeedKph: number;
  plannedInclineValue?: number;
  /**
   * An unknown unit lets the user select the correct incline type for their treadmill.
   */
  plannedInclineType: InclineType;
}

export interface SeedTemplateActivityDefinition {
  kind: ActivityKind;
  /** The durable label for the activity, e.g. `Treadmill`. */
  displayName: string;
  machineSeedKey?: string;
  exerciseSeedKey?: string;
  configSeedKey?: string;
  cardioTargets?: SeedCardioTargetDefinition[];
  /** A placeholder: what a number here will mean, with no numbers recorded yet. */
  strengthTarget?: { loadBasis: LoadBasis };
  notes?: string;
}

export interface SeedTemplateDefinition {
  seedKey: string;
  name: string;
  notes?: string;
  activities: readonly SeedTemplateActivityDefinition[];
}

/** Seed key for the starter routine. Renaming the template never changes this. */
export const STARTER_TEMPLATE_SEED_KEY = 'sample-gym-session';

export const STARTER_TEMPLATE: SeedTemplateDefinition = {
  seedKey: STARTER_TEMPLATE_SEED_KEY,
  name: 'Sample Gym Session',
  notes:
    'Your usual session: the treadmill run, the incline walk, then the strength machines you use. Change anything here — it is your routine, not a prescription.',
  activities: [
    {
      kind: 'cardio',
      displayName: 'Treadmill',
      cardioTargets: [
        {
          mode: 'run',
          plannedDistanceMeters: 2400,
          plannedSpeedKph: 9,
          plannedInclineType: 'unknown',
        },
        {
          mode: 'walk',
          plannedDistanceMeters: 1500,
          plannedSpeedKph: 5,
          plannedInclineValue: 6,
          plannedInclineType: 'unknown',
        },
      ],
    },
    {
      kind: 'strength',
      displayName: 'Plate-loaded leg press',
      machineSeedKey: 'plate-leg-press-01',
      exerciseSeedKey: 'plate-leg-press',
      // No default basis: per-side and total-added are both reasonable on this machine,
      // and choosing one here would silently label one as the other.
      strengthTarget: { loadBasis: 'unknown' },
    },
    {
      kind: 'strength',
      displayName: 'Seated leg press',
      machineSeedKey: 'seated-leg-press-01',
      exerciseSeedKey: 'seated-leg-press',
      strengthTarget: { loadBasis: 'stack_display' },
    },
    {
      kind: 'strength',
      displayName: 'Seated cable row',
      machineSeedKey: 'low-row-station-01',
      exerciseSeedKey: 'seated-cable-row',
      configSeedKey: 'low-row-station-01-seated-cable-row',
      strengthTarget: { loadBasis: 'stack_display' },
    },
  ],
};
