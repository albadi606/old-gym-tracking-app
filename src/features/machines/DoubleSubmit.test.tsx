import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ImageProcessor, OpenedImage } from '../../media/image-processor.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { MachineDetailPage } from './MachineDetailPage.tsx';
import { MachineFormPage } from './MachineFormPage.tsx';
import { MachinesPage } from './MachinesPage.tsx';

/**
 * One action must create one record.
 *
 * A thumb on a phone produces two clicks far more often than a mouse does, and both land
 * before React has re-rendered anything. Guarding this with disabled state alone is not
 * enough: the second handler has already started by the time the first `setState` is
 * processed, so the guard has to be a synchronous check that happens before the first
 * `await`. Firing two submit events in the same tick is exactly that situation.
 *
 * Duplicates here are unusually costly. Each submit mints a fresh UUID, so seed-key
 * uniqueness cannot catch them, and nothing afterwards can tell which of two identical
 * definitions the user meant to keep.
 */

function immediateProcessor(): ImageProcessor {
  return {
    open: (): Promise<OpenedImage> =>
      Promise.resolve({
        widthPx: 1200,
        heightPx: 900,
        encode: () =>
          Promise.resolve(
            new Blob([new Uint8Array(new ArrayBuffer(4096))], { type: 'image/webp' }),
          ),
        close: () => undefined,
      }),
  };
}

function routes(): React.ReactNode {
  return (
    <Routes>
      <Route path={ROUTE_PATHS.machines} element={<MachinesPage />} />
      <Route
        path={ROUTE_PATHS.machineNew}
        element={<MachineFormPage processor={immediateProcessor()} />}
      />
      <Route path={ROUTE_PATHS.machineDetail} element={<MachineDetailPage />} />
      <Route
        path={ROUTE_PATHS.machineEdit}
        element={<MachineFormPage processor={immediateProcessor()} />}
      />
    </Routes>
  );
}

/** The form element owning a submit button, so both events target the same form. */
function formFor(buttonName: string): HTMLFormElement {
  const button = screen.getByRole('button', { name: buttonName });
  const form = button.closest('form');
  if (!form) {
    throw new Error(`No form found for "${buttonName}"`);
  }
  return form;
}

describe('saving a new machine twice in one tick', () => {
  it('creates exactly one machine', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    await user.type(screen.getByLabelText('Name'), 'Double submit probe');

    const add = vi.spyOn(view.db.machines, 'add');
    const form = formFor('Save machine');
    // Both events dispatch before React can re-render a disabled button.
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByRole('heading', { level: 1, name: 'Double submit probe' });

    // Exactly one repository operation, and exactly one row.
    expect(add).toHaveBeenCalledTimes(1);
    await expect(
      view.db.machines.where('name').equals('Double submit probe').count(),
    ).resolves.toBe(1);
    await expect(view.db.machines.count()).resolves.toBe(5);

    await destroyTestDatabase(view.db);
  });

  it('stores one photo pair, not two', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    await user.type(screen.getByLabelText('Name'), 'Double photo probe');
    await user.upload(
      screen.getByLabelText('Choose a photo'),
      new File([new Uint8Array(new ArrayBuffer(30_000))], 'gym.webp', { type: 'image/webp' }),
    );
    await screen.findByText('Photo ready to save');

    const form = formFor('Save machine');
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByRole('heading', { level: 1, name: 'Double photo probe' });

    // 8 shipped assets plus one thumbnail and one detail. Not two of each.
    await expect(view.db.mediaAssets.count()).resolves.toBe(10);

    await destroyTestDatabase(view.db);
  });

  it('disables Save while the write is in flight', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });
    await user.type(screen.getByLabelText('Name'), 'Held machine');

    // Hold the write open so the pending state is observable.
    let release: (() => void) | undefined;
    vi.spyOn(view.db.machines, 'add').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve('held');
          };
        }) as ReturnType<typeof view.db.machines.add>,
    );

    fireEvent.submit(formFor('Save machine'));

    // The control keeps its accessible name so it stays findable, and reports progress
    // through aria-busy rather than by renaming itself.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save machine' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Save machine' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    release?.();
    await destroyTestDatabase(view.db);
  });
});

describe('saving an edit twice in one tick', () => {
  it('applies the change once and does not duplicate the machine', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machines,
      children: routes(),
    });

    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await user.click(await screen.findByRole('link', { name: 'Edit machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Edit machine' });

    const name = await screen.findByLabelText('Name');
    // The form fills from the record, which arrives after the input first renders. Waiting
    // for the stored value is what makes the clear below act on a populated field rather
    // than an empty one -- and it asserts that the form really was seeded from the record.
    await waitFor(() => {
      expect(name).toHaveValue('Low cable row station');
    });
    await user.clear(name);
    await user.type(name, 'Edited once');

    const put = vi.spyOn(view.db.machines, 'put');
    const form = formFor('Save changes');
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByRole('heading', { level: 1, name: 'Edited once' });

    expect(put).toHaveBeenCalledTimes(1);
    await expect(view.db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(view.db);
  });
});

describe('adding an exercise twice in one tick', () => {
  async function openCableStation(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: ROUTE_PATHS.machines, children: routes() });
    await user.click(await screen.findByRole('link', { name: 'Open Adjustable cable station' }));
    await screen.findByRole('heading', { level: 1, name: 'Adjustable cable station' });
    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    return view;
  }

  it('creates exactly one exercise and one configuration', async () => {
    const user = userEvent.setup();
    const view = await openCableStation();

    await user.type(screen.getByLabelText('Exercise name'), 'Double exercise probe');
    await user.type(screen.getByLabelText('Attachment'), 'Straight bar');

    const addExercise = vi.spyOn(view.db.exercises, 'add');
    const form = formFor('Add exercise');
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Double exercise probe' })).toBeInTheDocument();
    });

    expect(addExercise).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('heading', { name: 'Double exercise probe' })).toHaveLength(1);
    // Three seeded exercises plus exactly one new one, with exactly one configuration.
    await expect(view.db.exercises.count()).resolves.toBe(4);
    await expect(view.db.machineExerciseConfigs.count()).resolves.toBe(2);

    await destroyTestDatabase(view.db);
  });
});

describe('a rejected save', () => {
  it('re-enables the control, keeps the draft, and one retry creates one record', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    await user.type(screen.getByLabelText('Name'), 'Retried machine');
    await user.type(screen.getByLabelText('Other names'), 'Second name');

    vi.spyOn(view.db.machines, 'add').mockRejectedValueOnce(
      Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
    );

    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    expect(await screen.findByText('This machine was not saved')).toBeInTheDocument();

    // The guard released, so the user can act again.
    const save = await screen.findByRole('button', { name: 'Save machine' });
    expect(save).toBeEnabled();
    // Nothing the user typed was lost.
    expect(screen.getByLabelText('Name')).toHaveValue('Retried machine');
    expect(screen.getByLabelText('Other names')).toHaveValue('Second name');
    await expect(view.db.machines.count()).resolves.toBe(4);

    await user.click(save);
    await screen.findByRole('heading', { level: 1, name: 'Retried machine' });
    await expect(view.db.machines.where('name').equals('Retried machine').count()).resolves.toBe(1);

    await destroyTestDatabase(view.db);
  });

  it('re-enables the exercise form and keeps what was typed', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: ROUTE_PATHS.machines, children: routes() });
    await user.click(await screen.findByRole('link', { name: 'Open Adjustable cable station' }));
    await screen.findByRole('heading', { level: 1, name: 'Adjustable cable station' });
    await user.click(screen.getByRole('button', { name: 'Add exercise' }));

    await user.type(screen.getByLabelText('Exercise name'), 'Retried exercise');
    vi.spyOn(view.db.exercises, 'add').mockRejectedValueOnce(
      Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
    );

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    expect(await screen.findByText('This exercise was not added')).toBeInTheDocument();
    expect(screen.getByLabelText('Exercise name')).toHaveValue('Retried exercise');
    await expect(view.db.exercises.count()).resolves.toBe(3);

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Retried exercise' })).toBeInTheDocument();
    });
    await expect(view.db.exercises.count()).resolves.toBe(4);

    await destroyTestDatabase(view.db);
  });
});
