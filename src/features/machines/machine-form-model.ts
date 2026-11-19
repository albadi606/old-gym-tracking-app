import type { Machine } from '../../domain/catalog/schemas.ts';
import type {
  IdentificationConfidence,
  LoadBasis,
  LoadingKind,
  LoadUnit,
  MachineCategory,
  MuscleGroup,
} from '../../domain/enums.ts';
import type { MachinePatch } from '../../db/catalog-repository.ts';

/**
 * The machine form as data: values in, a validated record out.
 *
 * Keeping this pure is what makes "cancel writes nothing" and "an invalid step size is
 * refused" testable without rendering anything, and it keeps the component down to
 * markup and event handlers. Every field is a string or a plain array here because that
 * is what form controls actually hold; the conversion to typed record fields happens in
 * one place, at the bottom.
 */

export interface MachineFormValues {
  name: string;
  /** Comma-separated, exactly as typed. Split only when the record is built. */
  aliases: string;
  category: MachineCategory;
  loadingKind: LoadingKind;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  identificationConfidence: IdentificationConfidence;
  confirmationNote: string;
  /** `''` means "fall back to the layer above", not "kilograms". */
  defaultLoadUnit: LoadUnit | '';
  defaultLoadBasis: LoadBasis | '';
  incrementValue: string;
  incrementUnit: LoadUnit | '';
}

export const EMPTY_MACHINE_FORM: MachineFormValues = {
  name: '',
  aliases: '',
  category: 'other',
  loadingKind: 'other',
  primaryMuscles: [],
  secondaryMuscles: [],
  // A machine the user typed in has not been checked against anything.
  identificationConfidence: 'unverified',
  confirmationNote: '',
  defaultLoadUnit: '',
  defaultLoadBasis: '',
  incrementValue: '',
  incrementUnit: '',
};

export function machineToFormValues(machine: Machine): MachineFormValues {
  return {
    name: machine.name,
    aliases: machine.aliases.join(', '),
    category: machine.category,
    loadingKind: machine.loadingKind,
    primaryMuscles: [...machine.primaryMuscles],
    secondaryMuscles: [...machine.secondaryMuscles],
    identificationConfidence: machine.identificationConfidence,
    confirmationNote: machine.confirmationNote ?? '',
    defaultLoadUnit: machine.defaultLoadUnit ?? '',
    defaultLoadBasis: machine.defaultLoadBasis ?? '',
    incrementValue: machine.incrementValue === undefined ? '' : String(machine.incrementValue),
    incrementUnit: machine.incrementUnit ?? '',
  };
}

/** Splits on commas, trims, and drops blanks so `"a,, b ,"` yields `['a', 'b']`. */
export function parseAliases(input: string): string[] {
  return input
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

export type MachineFormErrors = Partial<Record<keyof MachineFormValues, string>>;

export interface MachineFormMessages {
  required: string;
  incrementPair: string;
  incrementPositive: string;
}

/**
 * Field-level validation.
 *
 * The increment rules mirror the schema's shared refinement rather than reimplementing
 * it: the pair travels together, and a step of zero is not a step. Catching it here means
 * the user sees the message beside the field instead of a save failure.
 */
export function validateMachineForm(
  values: MachineFormValues,
  messages: MachineFormMessages,
): MachineFormErrors {
  const errors: MachineFormErrors = {};

  if (values.name.trim().length === 0) {
    errors.name = messages.required;
  }

  const hasValue = values.incrementValue.trim().length > 0;
  const hasUnit = values.incrementUnit !== '';
  if (hasValue !== hasUnit) {
    errors.incrementValue = messages.incrementPair;
  } else if (hasValue) {
    const parsed = Number(values.incrementValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.incrementValue = messages.incrementPositive;
    }
  }

  return errors;
}

export function hasErrors(errors: MachineFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The optional half of a machine record.
 *
 * `exactOptionalPropertyTypes` means an explicit `undefined` is not the same as an absent
 * key and the strict schema rejects it, so a cleared field must be omitted entirely.
 */
function optionalFields(values: MachineFormValues): Record<string, unknown> {
  const increment =
    values.incrementValue.trim().length > 0 && values.incrementUnit !== ''
      ? { incrementValue: Number(values.incrementValue), incrementUnit: values.incrementUnit }
      : {};
  return {
    ...(values.defaultLoadUnit === '' ? {} : { defaultLoadUnit: values.defaultLoadUnit }),
    ...(values.defaultLoadBasis === '' ? {} : { defaultLoadBasis: values.defaultLoadBasis }),
    ...(values.confirmationNote.trim().length === 0
      ? {}
      : { confirmationNote: values.confirmationNote.trim() }),
    ...increment,
  };
}

export interface NewMachineIdentity {
  id: string;
  now: string;
}

/** A complete unvalidated machine record, ready for the repository to parse. */
export function formValuesToNewMachine(
  values: MachineFormValues,
  identity: NewMachineIdentity,
): Record<string, unknown> {
  return {
    id: identity.id,
    name: values.name.trim(),
    aliases: parseAliases(values.aliases),
    category: values.category,
    primaryMuscles: values.primaryMuscles,
    secondaryMuscles: values.secondaryMuscles,
    loadingKind: values.loadingKind,
    imageAssetIds: [],
    identificationConfidence: values.identificationConfidence,
    isFavorite: false,
    isSeeded: false,
    createdAt: identity.now,
    updatedAt: identity.now,
    ...optionalFields(values),
  };
}

/**
 * An edit patch.
 *
 * Fields the user cleared are set to `undefined`, which the repository translates into
 * removing the key. Identity, seed key, and `isSeeded` are absent by construction: a
 * correction never changes which machine a stored session refers to.
 */
export function formValuesToPatch(values: MachineFormValues): MachinePatch {
  const optional = optionalFields(values);
  return {
    name: values.name.trim(),
    aliases: parseAliases(values.aliases),
    category: values.category,
    primaryMuscles: values.primaryMuscles,
    secondaryMuscles: values.secondaryMuscles,
    loadingKind: values.loadingKind,
    identificationConfidence: values.identificationConfidence,
    defaultLoadUnit: optional.defaultLoadUnit as LoadUnit | undefined,
    defaultLoadBasis: optional.defaultLoadBasis as LoadBasis | undefined,
    confirmationNote: optional.confirmationNote as string | undefined,
    incrementValue: optional.incrementValue as number | undefined,
    incrementUnit: optional.incrementUnit as LoadUnit | undefined,
  };
}
