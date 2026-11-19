import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { MAX_INPUT_BYTES } from '../../domain/media/processing-contracts.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import type { ImageProcessor, OpenedImage } from '../../media/image-processor.ts';
import { MachineDetailPage } from './MachineDetailPage.tsx';
import { MachineFormPage } from './MachineFormPage.tsx';
import { MachinesPage } from './MachinesPage.tsx';

/**
 * Adding and editing a machine, including the photo path.
 *
 * jsdom has no canvas, so the decode/encode step is a stub. Everything else -- the
 * validation, the transaction, the refusal messages, and what ends up stored -- is the
 * real implementation.
 */

function stubProcessor(options: { failOpen?: boolean; outputSize?: number } = {}): ImageProcessor {
  return {
    open(): Promise<OpenedImage> {
      if (options.failOpen) {
        return Promise.reject(new Error('not an image'));
      }
      return Promise.resolve({
        widthPx: 1200,
        heightPx: 900,
        encode: () =>
          Promise.resolve(
            new Blob([new Uint8Array(new ArrayBuffer(options.outputSize ?? 5000))], {
              type: 'image/webp',
            }),
          ),
        close: () => undefined,
      });
    },
  };
}

function routes(processor: ImageProcessor): React.ReactNode {
  return (
    <Routes>
      <Route path={ROUTE_PATHS.machines} element={<MachinesPage />} />
      <Route path={ROUTE_PATHS.machineNew} element={<MachineFormPage processor={processor} />} />
      <Route path={ROUTE_PATHS.machineDetail} element={<MachineDetailPage />} />
      <Route path={ROUTE_PATHS.machineEdit} element={<MachineFormPage processor={processor} />} />
    </Routes>
  );
}

function photoFile(size = 100_000, type = 'image/jpeg', name = 'gym.jpg'): File {
  return new File([new Uint8Array(new ArrayBuffer(size))], name, { type });
}

async function openNewMachineForm(
  processor: ImageProcessor = stubProcessor(),
): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({
    route: ROUTE_PATHS.machineNew,
    children: routes(processor),
  });
  await screen.findByRole('heading', { level: 1, name: 'Add a machine' });
  return view;
}

describe('adding a machine', () => {
  it('saves a machine and opens it', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.type(screen.getByLabelText('Name'), 'Standing calf raise');
    await user.type(screen.getByLabelText('Other names'), 'Calf machine, Standing calf');
    await user.selectOptions(screen.getByLabelText('Area of the body'), 'lower_body');
    await user.selectOptions(screen.getByLabelText('How it is loaded'), 'selectorized');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));

    // It navigated to the new machine's own page.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Standing calf raise' }),
    ).toBeInTheDocument();

    const stored = await view.db.machines.where('name').equals('Standing calf raise').first();
    expect(stored?.aliases).toEqual(['Calf machine', 'Standing calf']);
    expect(stored?.isSeeded).toBe(false);
    // A machine the user typed in has not been checked against anything.
    expect(stored?.identificationConfidence).toBe('unverified');
    await expect(view.db.machines.count()).resolves.toBe(5);

    await destroyTestDatabase(view.db);
  });

  it('refuses a nameless machine and writes nothing', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.click(screen.getByRole('button', { name: 'Save machine' }));

    const name = screen.getByLabelText('Name');
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(expect.stringContaining('Enter a name.'));
    await expect(view.db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(view.db);
  });

  it('refuses half a step size and explains which half is missing', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.type(screen.getByLabelText('Name'), 'Machine');
    await user.type(screen.getByLabelText('Step size'), '2.5');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));

    expect(
      await screen.findByText('Enter both a step size and its unit, or leave both blank.'),
    ).toBeInTheDocument();
    await expect(view.db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(view.db);
  });

  it('refuses a step size of zero', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.type(screen.getByLabelText('Name'), 'Machine');
    await user.type(screen.getByLabelText('Step size'), '0');
    await user.selectOptions(screen.getByLabelText('Step unit'), 'kg');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));

    expect(await screen.findByText('The step size must be greater than zero.')).toBeInTheDocument();
    await expect(view.db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(view.db);
  });

  it('writes nothing when the form is cancelled', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.type(screen.getByLabelText('Name'), 'Abandoned machine');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Machines' })).toBeInTheDocument();
    await expect(view.db.machines.count()).resolves.toBe(4);
    await expect(view.db.machines.where('name').equals('Abandoned machine').count()).resolves.toBe(
      0,
    );

    await destroyTestDatabase(view.db);
  });
});

describe('adding a machine with a photo', () => {
  it('stores the machine and both photo variants together', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.type(screen.getByLabelText('Name'), 'Chest press');
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    expect(await screen.findByText('Photo ready to save')).toBeInTheDocument();

    // Nothing is written before Save: the photo is only a draft so far.
    await expect(view.db.mediaAssets.count()).resolves.toBe(8);

    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Chest press' });

    const stored = await view.db.machines.where('name').equals('Chest press').first();
    expect(stored?.imageAssetIds).toHaveLength(2);
    await expect(view.db.mediaAssets.count()).resolves.toBe(10);

    const assets = await view.db.mediaAssets.bulkGet(stored?.imageAssetIds ?? []);
    for (const asset of assets) {
      expect(asset?.kind).toBe('user_photo');
      expect(asset?.storageKind).toBe('indexeddb_blob');
      // Every stored fact comes from the encoded output, never from the file's name.
      expect(asset?.mimeType).toBe('image/webp');
    }
    expect(assets.map((asset) => asset?.role).sort()).toEqual(['detail', 'thumbnail']);

    await destroyTestDatabase(view.db);
  });

  it('reports a refused photo, keeps the typed values, and saves nothing', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm(stubProcessor({ failOpen: true }));

    await user.type(screen.getByLabelText('Name'), 'Chest press');
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());

    expect(
      await screen.findByText('The file could not be read as an image, whatever its name says.'),
    ).toBeInTheDocument();
    // The rest of the form survived the refusal.
    expect(screen.getByLabelText('Name')).toHaveValue('Chest press');
    await expect(view.db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(view.db);
  });

  it('refuses an unsupported file type without attempting to decode it', async () => {
    const view = await openNewMachineForm();

    // `accept` is only a hint: a file dialog set to "All files" hands the page whatever
    // was chosen, so the refusal is driven the way the browser would deliver it.
    const input = screen.getByLabelText('Choose a photo');
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    Object.defineProperty(input, 'files', { value: [svg], configurable: true });
    fireEvent.change(input);

    expect(
      await screen.findByText(
        'That file type is not supported. Use a JPEG, PNG, WebP, or AVIF photo.',
      ),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('refuses a file past the input limit', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.upload(screen.getByLabelText('Choose a photo'), photoFile(MAX_INPUT_BYTES + 1));

    expect(
      await screen.findByText('The file is larger than this app will accept. Try a smaller photo.'),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('lets the user drop a prepared photo again before saving', async () => {
    const user = userEvent.setup();
    const view = await openNewMachineForm();

    await user.type(screen.getByLabelText('Name'), 'Chest press');
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    await screen.findByText('Photo ready to save');

    await user.click(screen.getByRole('button', { name: 'Remove photo' }));
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Chest press' });

    const stored = await view.db.machines.where('name').equals('Chest press').first();
    expect(stored?.imageAssetIds).toEqual([]);
    // No orphan photo was written for a machine that ended up without one.
    await expect(view.db.mediaAssets.count()).resolves.toBe(8);

    await destroyTestDatabase(view.db);
  });
});

describe('editing a machine', () => {
  it('opens with the stored values already filled in', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machines,
      children: routes(stubProcessor()),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await user.click(await screen.findByRole('link', { name: 'Edit machine' }));

    expect(await screen.findByLabelText('Name')).toHaveValue('Low cable row station');
    expect(screen.getByLabelText('Other names')).toHaveValue(
      'Low row machine, Seated cable row station',
    );
    expect(screen.getByLabelText('How certain the identification is')).toHaveValue('high');

    await destroyTestDatabase(view.db);
  });

  it('renames a seeded machine without changing its identity', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machines,
      children: routes(stubProcessor()),
    });
    const user = userEvent.setup();
    const before = await view.db.machines.where('seedKey').equals('low-row-station-01').first();

    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await user.click(await screen.findByRole('link', { name: 'Edit machine' }));

    const name = await screen.findByLabelText('Name');
    // The form fills from the record, which arrives after the input first renders. Waiting
    // for the stored value is what makes the clear below act on a populated field rather
    // than an empty one -- and it asserts that the form really was seeded from the record.
    await waitFor(() => {
      expect(name).toHaveValue('Low cable row station');
    });
    await user.clear(name);
    await user.type(name, 'The row machine by the window');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'The row machine by the window' }),
    ).toBeInTheDocument();

    const after = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(after?.id).toBe(before?.id);
    expect(after?.seedKey).toBe('low-row-station-01');
    expect(after?.isSeeded).toBe(true);
    expect(after?.createdAt).toBe(before?.createdAt);
    // The photos it already had are untouched by a rename.
    expect(after?.imageAssetIds).toEqual(before?.imageAssetIds);

    await destroyTestDatabase(view.db);
  });

  it('leaves the record alone when the edit is cancelled', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machines,
      children: routes(stubProcessor()),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await user.click(await screen.findByRole('link', { name: 'Edit machine' }));

    const name = await screen.findByLabelText('Name');
    // The form fills from the record, which arrives after the input first renders. Waiting
    // for the stored value is what makes the clear below act on a populated field rather
    // than an empty one -- and it asserts that the form really was seeded from the record.
    await waitFor(() => {
      expect(name).toHaveValue('Low cable row station');
    });
    await user.clear(name);
    await user.type(name, 'Discarded name');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Low cable row station' }),
    ).toBeInTheDocument();
    const stored = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(stored?.name).toBe('Low cable row station');

    await destroyTestDatabase(view.db);
  });

  it('says so when the address names no machine', async () => {
    const view = await renderWithDatabase({
      route: '/machines/00000000-0000-4000-8000-000000000999/edit',
      children: routes(stubProcessor()),
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'That machine is not in your catalog' }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
