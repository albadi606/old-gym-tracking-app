import { describe, expect, it } from 'vitest';

import { createFixedClock } from '../domain/clock.ts';
import { SINGLETON_ID } from '../domain/schemas.ts';
import {
  createOpenTestDatabase,
  createTestDatabase,
  destroyTestDatabase,
} from '../test/database.ts';
import { makeMachine, testClock } from '../test/fixtures.ts';
import { initializeDatabase } from './initialize.ts';
import {
  DuplicateSeedKeyError,
  getMachine,
  getMachineBySeedKey,
  listActiveMachines,
  putMachine,
  RecordValidationError,
  updateSettings,
} from './repositories.ts';

describe('validated persistence boundary', () => {
  it('stores a valid record and reads it back unchanged', async () => {
    const db = await createOpenTestDatabase('repo-put');

    const machine = makeMachine({ name: 'Adjustable cable station', seedKey: 'adjustable-cable' });
    await putMachine(db, machine);

    await expect(getMachine(db, machine.id)).resolves.toEqual(machine);
    await expect(getMachineBySeedKey(db, 'adjustable-cable')).resolves.toEqual(machine);

    await destroyTestDatabase(db);
  });

  it('refuses a malformed record and writes nothing', async () => {
    const db = await createOpenTestDatabase('repo-reject');

    await expect(putMachine(db, makeMachine({ id: 'leg-press' }))).rejects.toBeInstanceOf(
      RecordValidationError,
    );
    await expect(
      putMachine(db, { ...makeMachine(), loadingKind: 'hydraulic' }),
    ).rejects.toBeInstanceOf(RecordValidationError);
    await expect(db.machines.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('names the failing field without echoing the record', async () => {
    const db = await createOpenTestDatabase('repo-error-message');

    const secretNote = 'private note that must not leak';
    let caught: unknown;
    try {
      await putMachine(db, makeMachine({ id: 'not-a-uuid', confirmationNote: secretNote }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordValidationError);
    const message = (caught as RecordValidationError).message;
    expect(message).toContain('id');
    expect(message).not.toContain(secretNote);

    await destroyTestDatabase(db);
  });

  it('excludes archived catalog entries from the active list but keeps the record', async () => {
    const db = await createOpenTestDatabase('repo-archive');

    const active = makeMachine({ id: '11111111-1111-4111-8111-111111111111', name: 'Active' });
    const archived = makeMachine({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Archived',
      archivedAt: '2026-08-28T06:00:00.000Z',
    });
    await putMachine(db, active);
    await putMachine(db, archived);

    await expect(listActiveMachines(db)).resolves.toEqual([active]);
    // History referencing the archived machine can still resolve it.
    await expect(getMachine(db, archived.id)).resolves.toEqual(archived);

    await destroyTestDatabase(db);
  });
});

describe('settings', () => {
  it('applies a patch, stamps updatedAt, and revalidates the whole record', async () => {
    const db = createTestDatabase('settings-update');
    await initializeDatabase({ db, clock: testClock });

    const later = createFixedClock('2026-08-28T07:30:00.000Z');
    const updated = await updateSettings(db, { preferredLoadUnit: 'lb' }, later);

    expect(updated.preferredLoadUnit).toBe('lb');
    expect(updated.createdAt).toBe(testClock.nowIso());
    expect(updated.updatedAt).toBe(later.nowIso());
    await expect(db.settings.get(SINGLETON_ID)).resolves.toEqual(updated);

    await destroyTestDatabase(db);
  });

  it('rejects a patch that would make the singleton invalid', async () => {
    const db = createTestDatabase('settings-invalid');
    await initializeDatabase({ db, clock: testClock });

    await expect(updateSettings(db, { firstDayOfWeek: 9 })).rejects.toBeInstanceOf(
      RecordValidationError,
    );
    await expect(db.settings.get(SINGLETON_ID)).resolves.toMatchObject({ firstDayOfWeek: 1 });

    await destroyTestDatabase(db);
  });
});

describe('seed identity', () => {
  it('refuses a second record claiming an existing seed key', async () => {
    const db = await createOpenTestDatabase('repo-seed-key');

    const first = makeMachine({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Low cable row station',
      seedKey: 'low-row-station-01',
    });
    const impostor = makeMachine({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'A different machine',
      seedKey: 'low-row-station-01',
    });

    await putMachine(db, first);
    await expect(putMachine(db, impostor)).rejects.toBeInstanceOf(DuplicateSeedKeyError);

    // Lookup stays unambiguous and the original record is untouched.
    await expect(db.machines.count()).resolves.toBe(1);
    await expect(getMachineBySeedKey(db, 'low-row-station-01')).resolves.toEqual(first);

    await destroyTestDatabase(db);
  });

  it('still lets the same record be updated in place under its own seed key', async () => {
    const db = await createOpenTestDatabase('repo-seed-key-update');

    const machine = makeMachine({ seedKey: 'low-row-station-01' });
    await putMachine(db, machine);
    const renamed = { ...machine, name: 'Low row (renamed)' };
    await putMachine(db, renamed);

    await expect(db.machines.count()).resolves.toBe(1);
    await expect(getMachineBySeedKey(db, 'low-row-station-01')).resolves.toEqual(renamed);

    await destroyTestDatabase(db);
  });

  it('places no limit on records that carry no seed key', async () => {
    const db = await createOpenTestDatabase('repo-no-seed-key');

    await putMachine(db, makeMachine({ id: '11111111-1111-4111-8111-111111111111' }));
    await putMachine(db, makeMachine({ id: '22222222-2222-4222-8222-222222222222' }));
    await putMachine(db, makeMachine({ id: '33333333-3333-4333-8333-333333333333' }));

    await expect(db.machines.count()).resolves.toBe(3);

    await destroyTestDatabase(db);
  });
});
