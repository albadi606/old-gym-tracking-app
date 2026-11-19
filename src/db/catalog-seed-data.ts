import type {
  IdentificationConfidence,
  LoadBasis,
  LoadingKind,
  MachineCategory,
  MovementPattern,
  MuscleGroup,
  TrackingKind,
} from '../domain/enums.ts';

/**
 * The starter catalog includes common gym machines, exercises, and example setup notes.
 *
 * This is *data*, not user-interface copy, which is why it lives beside the seed rather
 * than in `i18n/`. Every field here becomes an editable database record the moment the
 * seed runs: the user can rename any machine, correct any alias, and rewrite any note,
 * and a later initialization preserves those edits.
 *
 * What is deliberately absent matters as much as what is present. No brand, no model, no
 * empty-sled weight, no stack unit, and no cable ratio appears anywhere below, because
 * none of those can be read off a photograph. Each machine carries a confirmation note
 * that says plainly what is known and what is not, and the catalog shows it.
 */

export interface SeedMachineDefinition {
  seedKey: string;
  name: string;
  aliases: string[];
  category: MachineCategory;
  loadingKind: LoadingKind;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  identificationConfidence: IdentificationConfidence;
  confirmationNote: string;
  defaultLoadBasis?: LoadBasis;
  /** Alt text for both photo variants. Describes what is visible, never a model. */
  altText: string;
}

export const SEED_MACHINES: readonly SeedMachineDefinition[] = [
  {
    seedKey: 'plate-leg-press-01',
    name: 'Plate-loaded seated leg press',
    aliases: ['Plate-loaded leg press', 'Reclined leg press'],
    category: 'lower_body',
    loadingKind: 'plate_loaded',
    primaryMuscles: ['quadriceps', 'glutes'],
    secondaryMuscles: ['hamstrings', 'calves'],
    identificationConfidence: 'high',
    confirmationNote:
      'This sample entry illustrates a plate-loaded seated leg press. The brand, model, and the weight of the empty sled are unknown, so the number you enter counts only the plates you add. Choose whether you are recording the plates on each side or the total added, because the two are not the same number.',
    // No default basis: per-side and total-added are both reasonable here, and guessing
    // would silently label one as the other.
    altText: 'Plate-loaded seated leg press with a reclined backrest and side plate horn.',
  },
  {
    seedKey: 'seated-leg-press-01',
    name: 'Selectorized seated leg press',
    aliases: ['Seated leg press', 'Horizontal leg press', 'Stack leg press'],
    category: 'lower_body',
    loadingKind: 'selectorized',
    primaryMuscles: ['quadriceps', 'glutes'],
    secondaryMuscles: ['hamstrings', 'calves'],
    identificationConfidence: 'high',
    confirmationNote:
      'This sample entry illustrates a selectorized seated leg press with a weight stack. The brand and model, the unit printed beside the pin, and the size of each stack step are all unconfirmed, so entries record the number shown next to the pin exactly as you read it. Set the unit and increment yourself once you have checked the machine.',
    defaultLoadBasis: 'stack_display',
    altText: 'Selectorized seated leg press with a large footplate and weight stack.',
  },
  {
    seedKey: 'adjustable-cable-01',
    name: 'Adjustable cable station',
    aliases: ['Cable machine', 'Adjustable pulley', 'Single pulley station'],
    category: 'full_body',
    loadingKind: 'cable',
    // Muscles are left unrecorded on purpose: which ones this station works depends
    // entirely on the exercise, and no exercise has been confirmed on it yet.
    primaryMuscles: [],
    secondaryMuscles: [],
    identificationConfidence: 'high',
    confirmationNote:
      'This sample entry illustrates an adjustable single-pulley cable station. It is one machine that supports many different exercises, so the movement, the attachment, and the pulley height are recorded per exercise rather than here. The brand, the stack unit, and the cable ratio are unknown, which means the number beside the pin is not necessarily the force at the handle. No exercise has been added yet — add the ones you actually perform.',
    defaultLoadBasis: 'stack_display',
    altText: 'Adjustable single-pulley cable station with a movable cable carriage.',
  },
  {
    seedKey: 'low-row-station-01',
    name: 'Low cable row station',
    aliases: ['Low row machine', 'Seated cable row station'],
    category: 'upper_body',
    loadingKind: 'cable',
    primaryMuscles: ['back'],
    secondaryMuscles: ['biceps', 'forearms'],
    identificationConfidence: 'high',
    confirmationNote:
      'This sample entry illustrates a low cable row station. The brand, the stack unit, and the cable ratio are unknown, so entries record the number shown beside the pin and are only compared against other entries on this same station.',
    defaultLoadBasis: 'stack_display',
    altText:
      'Low cable row station with footplates, a low pulley, and a selectorized weight stack.',
  },
];

const SAMPLE_ROW_SETUP_NOTE = 'Save the handle and footplate positions for this setup.';

export interface SeedExerciseDefinition {
  seedKey: string;
  machineSeedKey: string;
  name: string;
  aliases: string[];
  movementPattern: MovementPattern;
  trackingKind: TrackingKind;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  defaultAttachment?: string;
  defaultPulleyPosition?: string;
  defaultSetupNote?: string;
}

/**
 * Only movements that are confirmed or unambiguous for the equipment shown.
 *
 * The adjustable cable station deliberately has none. Curls, pushdowns, and presses are
 * all plausible on it, and plausible is not the same as recorded -- the catalog offers an
 * "Add exercise" action there instead of inventing one.
 */
export const SEED_EXERCISES: readonly SeedExerciseDefinition[] = [
  {
    seedKey: 'plate-leg-press',
    machineSeedKey: 'plate-leg-press-01',
    name: 'Plate-loaded leg press',
    aliases: ['Leg press'],
    movementPattern: 'push',
    trackingKind: 'strength',
    primaryMuscles: ['quadriceps', 'glutes'],
    secondaryMuscles: ['hamstrings', 'calves'],
  },
  {
    seedKey: 'seated-leg-press',
    machineSeedKey: 'seated-leg-press-01',
    name: 'Seated leg press',
    aliases: ['Machine leg press'],
    movementPattern: 'push',
    trackingKind: 'strength',
    primaryMuscles: ['quadriceps', 'glutes'],
    secondaryMuscles: ['hamstrings', 'calves'],
  },
  {
    seedKey: 'seated-cable-row',
    machineSeedKey: 'low-row-station-01',
    name: 'Seated cable row',
    aliases: ['Low row', 'Cable row'],
    movementPattern: 'pull',
    trackingKind: 'strength',
    primaryMuscles: ['back'],
    secondaryMuscles: ['biceps', 'forearms'],
    defaultAttachment: 'Straight bar',
    defaultPulleyPosition: 'Low',
    defaultSetupNote: SAMPLE_ROW_SETUP_NOTE,
  },
];

export interface SeedConfigDefinition {
  seedKey: string;
  machineSeedKey: string;
  exerciseSeedKey: string;
  attachment?: string;
  pulleyPosition?: string;
  setupNote?: string;
  defaultLoadBasis?: LoadBasis;
}

export const SEED_CONFIGS: readonly SeedConfigDefinition[] = [
  {
    seedKey: 'low-row-station-01-seated-cable-row',
    machineSeedKey: 'low-row-station-01',
    exerciseSeedKey: 'seated-cable-row',
    attachment: 'Straight bar',
    pulleyPosition: 'Low',
    setupNote: SAMPLE_ROW_SETUP_NOTE,
    defaultLoadBasis: 'stack_display',
  },
];
