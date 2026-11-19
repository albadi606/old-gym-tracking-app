import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { GymTrackerDatabase } from '../../db/database.ts';
import type { ImageProcessor, OpenedImage } from '../../media/image-processor.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { MachineDetailPage } from './MachineDetailPage.tsx';
import { MachineFormPage } from './MachineFormPage.tsx';
import { MachinesPage } from './MachinesPage.tsx';

/**
 * The save lifecycle around a photo.
 *
 * Three things can go wrong between choosing a file and having a machine on disk, and all
 * three are invisible unless tested deliberately: the description can be captured before
 * the user finishes naming the machine, Save can run while the image is still being
 * prepared, and an edit can commit its text half while its photo half fails.
 */

interface DeferredProcessor {
  processor: ImageProcessor;
  /** Lets the pending decode finish, on demand. */
  release: () => void;
  opened: () => number;
}

function deferredProcessor(): DeferredProcessor {
  let resolveOpen: (() => void) | undefined;
  let openCount = 0;

  const processor: ImageProcessor = {
    async open(): Promise<OpenedImage> {
      openCount += 1;
      await new Promise<void>((resolve) => {
        resolveOpen = resolve;
      });
      return {
        widthPx: 1200,
        heightPx: 900,
        encode: () =>
          Promise.resolve(
            new Blob([new Uint8Array(new ArrayBuffer(4096))], { type: 'image/webp' }),
          ),
        close: () => undefined,
      };
    },
  };

  return {
    processor,
    release: () => {
      resolveOpen?.();
    },
    opened: () => openCount,
  };
}

function immediateProcessor(size = 4096): ImageProcessor {
  return {
    open: () =>
      Promise.resolve({
        widthPx: 1200,
        heightPx: 900,
        encode: () =>
          Promise.resolve(
            new Blob([new Uint8Array(new ArrayBuffer(size))], { type: 'image/webp' }),
          ),
        close: () => undefined,
      }),
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

const PHOTO_FILE_NAME = 'low-row-station-01-thumb.webp';

function photoFile(): File {
  return new File([new Uint8Array(new ArrayBuffer(50_000))], PHOTO_FILE_NAME, {
    type: 'image/webp',
  });
}

async function storedAltTexts(db: GymTrackerDatabase, machineName: string): Promise<string[]> {
  const machine = await db.machines.where('name').equals(machineName).first();
  const assets = await db.mediaAssets.bulkGet(machine?.imageAssetIds ?? []);
  return assets.map((asset) => asset?.altText ?? '');
}

describe('the stored photo description', () => {
  it('follows the machine name even when the photo was chosen first', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(immediateProcessor()),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    // Regression case: pick the photo before typing anything.
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    await screen.findByText('Photo ready to save');
    await user.type(screen.getByLabelText('Name'), 'Photo first machine');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Photo first machine' });

    const alts = await storedAltTexts(view.db, 'Photo first machine');
    expect(alts).toEqual(['Photo first machine', 'Photo first machine']);
    for (const alt of alts) {
      expect(alt).not.toContain('.webp');
      expect(alt).not.toContain(PHOTO_FILE_NAME);
    }

    await destroyTestDatabase(view.db);
  });

  it('follows a rename made after the photo was prepared', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(immediateProcessor()),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    const name = screen.getByLabelText('Name');
    await user.type(name, 'First name');
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    await screen.findByText('Photo ready to save');

    // The description must not be frozen at the moment the file was chosen.
    await user.clear(name);
    await user.type(name, 'Corrected name');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Corrected name' });

    expect(await storedAltTexts(view.db, 'Corrected name')).toEqual([
      'Corrected name',
      'Corrected name',
    ]);

    await destroyTestDatabase(view.db);
  });

  it('never lets a filename reach anything the user or a screen reader sees', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(immediateProcessor()),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    await screen.findByText('Photo ready to save');
    await user.type(screen.getByLabelText('Name'), 'Announced machine');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Announced machine',
    });

    /*
     * This used to assert the "photo could not be displayed" fallback, because a Blob did
     * not survive the test database and the object URL could not be minted. The test database now round-trips Blobs like a browser, so the photo
     * renders -- which lets this assert the stronger thing it always meant: the picture is
     * announced by the description the user settled on, and the filename appears nowhere.
     */
    expect(heading).toBeInTheDocument();
    expect(screen.queryByText(PHOTO_FILE_NAME)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(PHOTO_FILE_NAME);
    expect(screen.getByRole('img', { name: 'Announced machine' })).toBeInTheDocument();

    // What was stored is still the label, which is what a browser will announce.
    expect(await storedAltTexts(view.db, 'Announced machine')).toEqual([
      'Announced machine',
      'Announced machine',
    ]);

    await destroyTestDatabase(view.db);
  });
});

describe('saving while a photo is still being prepared', () => {
  it('does not create the machine without the photo the user chose', async () => {
    const user = userEvent.setup();
    const deferred = deferredProcessor();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(deferred.processor),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    await user.type(screen.getByLabelText('Name'), 'Slow photo machine');
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    await screen.findByText('Preparing photo');

    const save = screen.getByRole('button', { name: 'Save machine' });
    expect(save).toBeDisabled();
    await user.click(save);

    // Still on the form, and nothing has been written.
    expect(screen.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeInTheDocument();
    await expect(view.db.machines.count()).resolves.toBe(4);

    // Once preparation finishes, the same Save now includes the photo.
    deferred.release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save machine' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Slow photo machine' });

    const stored = await view.db.machines.where('name').equals('Slow photo machine').first();
    expect(stored?.imageAssetIds).toHaveLength(2);

    await destroyTestDatabase(view.db);
  });

  it('keeps the most recent selection when two decodes overlap', async () => {
    const user = userEvent.setup();
    // The first decode never resolves; the second does. The stale one must not win.
    let openCount = 0;
    const processor: ImageProcessor = {
      open(): Promise<OpenedImage> {
        openCount += 1;
        const size = openCount === 1 ? 1111 : 2222;
        if (openCount === 1) {
          return new Promise<OpenedImage>(() => undefined);
        }
        return Promise.resolve({
          widthPx: 1200,
          heightPx: 900,
          encode: () =>
            Promise.resolve(
              new Blob([new Uint8Array(new ArrayBuffer(size))], { type: 'image/webp' }),
            ),
          close: () => undefined,
        });
      },
    };

    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machineNew,
      children: routes(processor),
    });
    await screen.findByRole('heading', { level: 1, name: 'Add a machine' });

    await user.type(screen.getByLabelText('Name'), 'Second choice');
    const input = screen.getByLabelText('Choose a photo');
    await user.upload(input, photoFile());
    await user.upload(input, photoFile());
    await screen.findByText('Photo ready to save');

    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Second choice' });

    const stored = await view.db.machines.where('name').equals('Second choice').first();
    const assets = await view.db.mediaAssets.bulkGet(stored?.imageAssetIds ?? []);
    // 2222 bytes is the second selection; 1111 would mean the abandoned one won.
    expect(assets[0]?.byteSize).toBe(2222);

    await destroyTestDatabase(view.db);
  });
});

describe('an edit whose photo cannot be stored', () => {
  it('leaves the machine and its photos exactly as they were', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.machines,
      children: routes(immediateProcessor()),
    });

    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await user.click(await screen.findByRole('link', { name: 'Edit machine' }));
    await screen.findByRole('heading', { level: 1, name: 'Edit machine' });

    const before = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    const mediaCountBefore = await view.db.mediaAssets.count();

    // Storage refuses the photo half of the save.
    vi.spyOn(view.db.mediaAssets, 'bulkPut').mockRejectedValueOnce(
      Object.assign(new Error('quota'), { name: 'QuotaExceededError' }),
    );

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed but not saved');
    await user.upload(screen.getByLabelText('Choose a photo'), photoFile());
    await screen.findByText('Photo ready to save');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('This machine was not saved')).toBeInTheDocument();

    // The rename must not have survived on its own: the whole Save is one unit.
    const after = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(after?.name).toBe(before?.name);
    expect(after?.imageAssetIds).toEqual(before?.imageAssetIds);
    await expect(view.db.mediaAssets.count()).resolves.toBe(mediaCountBefore);

    await destroyTestDatabase(view.db);
  });
});
