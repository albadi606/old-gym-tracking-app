import { describe, expect, it } from 'vitest';

import { makeMachine } from '../../test/fixtures.ts';
import {
  EMPTY_MACHINE_FORM,
  formValuesToNewMachine,
  formValuesToPatch,
  hasErrors,
  type MachineFormValues,
  machineToFormValues,
  parseAliases,
  validateMachineForm,
} from './machine-form-model.ts';
import { machineSchema } from '../../domain/catalog/schemas.ts';

const messages = {
  required: 'Enter a name.',
  incrementPair: 'Enter both a step size and its unit, or leave both blank.',
  incrementPositive: 'The step size must be greater than zero.',
};

function values(overrides: Partial<MachineFormValues> = {}): MachineFormValues {
  return { ...EMPTY_MACHINE_FORM, name: 'My machine', ...overrides };
}

describe('aliases', () => {
  it('splits on commas, trims, and drops blanks', () => {
    expect(parseAliases('Low row ,, Cable row ,')).toEqual(['Low row', 'Cable row']);
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases('   ')).toEqual([]);
  });

  it('round-trips through the form and back', () => {
    const machine = makeMachine({ aliases: ['Low row', 'Cable row'] });
    expect(parseAliases(machineToFormValues(machine).aliases)).toEqual(machine.aliases);
  });
});

describe('validation', () => {
  it('accepts a minimal but complete form', () => {
    expect(hasErrors(validateMachineForm(values(), messages))).toBe(false);
  });

  it('requires a name that is not just whitespace', () => {
    expect(validateMachineForm(values({ name: '' }), messages).name).toBe(messages.required);
    expect(validateMachineForm(values({ name: '   ' }), messages).name).toBe(messages.required);
  });

  it('requires the step size and its unit together', () => {
    expect(validateMachineForm(values({ incrementValue: '2.5' }), messages).incrementValue).toBe(
      messages.incrementPair,
    );
    expect(validateMachineForm(values({ incrementUnit: 'kg' }), messages).incrementValue).toBe(
      messages.incrementPair,
    );
    expect(
      validateMachineForm(values({ incrementValue: '2.5', incrementUnit: 'kg' }), messages)
        .incrementValue,
    ).toBeUndefined();
  });

  it('refuses a step that is zero, negative, or not a number', () => {
    for (const bad of ['0', '-1', 'heavy', 'NaN']) {
      expect(
        validateMachineForm(values({ incrementValue: bad, incrementUnit: 'kg' }), messages)
          .incrementValue,
        bad,
      ).toBe(messages.incrementPositive);
    }
  });
});

describe('building a new machine record', () => {
  const identity = { id: '00000000-0000-4000-8000-000000000001', now: '2026-08-28T05:00:00.000Z' };

  it('produces a record the persistence schema accepts', () => {
    const record = formValuesToNewMachine(
      values({ name: '  Spaced name  ', aliases: 'A, B' }),
      identity,
    );
    const parsed = machineSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe('Spaced name');
    expect(parsed.success && parsed.data.aliases).toEqual(['A', 'B']);
  });

  it('marks a hand-entered machine as unverified and not seeded', () => {
    const record = formValuesToNewMachine(values(), identity);
    expect(record.identificationConfidence).toBe('unverified');
    expect(record.isSeeded).toBe(false);
    expect(record.isFavorite).toBe(false);
    expect(record.seedKey).toBeUndefined();
  });

  it('omits an unset optional field entirely rather than storing undefined', () => {
    const record = formValuesToNewMachine(values(), identity);
    // `strictObject` with exactOptionalPropertyTypes rejects an explicit undefined.
    expect('defaultLoadUnit' in record).toBe(false);
    expect('defaultLoadBasis' in record).toBe(false);
    expect('incrementValue' in record).toBe(false);
    expect('confirmationNote' in record).toBe(false);
  });

  it('keeps a chosen basis and a complete step pair', () => {
    const record = formValuesToNewMachine(
      values({
        defaultLoadBasis: 'per_side',
        defaultLoadUnit: 'lb',
        incrementValue: '5',
        incrementUnit: 'lb',
      }),
      identity,
    );
    expect(record).toMatchObject({
      defaultLoadBasis: 'per_side',
      defaultLoadUnit: 'lb',
      incrementValue: 5,
      incrementUnit: 'lb',
    });
    expect(machineSchema.safeParse(record).success).toBe(true);
  });
});

describe('building an edit patch', () => {
  it('never carries identity, seed key, or seeded-ness', () => {
    const patch = formValuesToPatch(values());
    expect('id' in patch).toBe(false);
    expect('seedKey' in patch).toBe(false);
    expect('isSeeded' in patch).toBe(false);
    expect('createdAt' in patch).toBe(false);
  });

  it('clears an emptied optional field by setting it undefined', () => {
    const machine = makeMachine({
      confirmationNote: 'Unconfirmed brand',
      defaultLoadBasis: 'per_side',
      incrementValue: 2.5,
      incrementUnit: 'kg',
    });
    const cleared = formValuesToPatch({
      ...machineToFormValues(machine),
      confirmationNote: '',
      defaultLoadBasis: '',
      incrementValue: '',
      incrementUnit: '',
    });
    expect(cleared.confirmationNote).toBeUndefined();
    expect(cleared.defaultLoadBasis).toBeUndefined();
    expect(cleared.incrementValue).toBeUndefined();
    expect(cleared.incrementUnit).toBeUndefined();
  });

  it('round-trips an existing machine unchanged when nothing is edited', () => {
    const machine = makeMachine({
      name: 'Low cable row station',
      aliases: ['Low row'],
      category: 'upper_body',
      loadingKind: 'cable',
      primaryMuscles: ['back'],
      secondaryMuscles: ['biceps'],
      identificationConfidence: 'owner_confirmed',
      defaultLoadBasis: 'stack_display',
    });
    const patch = formValuesToPatch(machineToFormValues(machine));

    expect(patch).toMatchObject({
      name: machine.name,
      aliases: machine.aliases,
      category: machine.category,
      loadingKind: machine.loadingKind,
      primaryMuscles: machine.primaryMuscles,
      secondaryMuscles: machine.secondaryMuscles,
      identificationConfidence: machine.identificationConfidence,
      defaultLoadBasis: 'stack_display',
    });
  });
});
