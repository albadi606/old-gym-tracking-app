import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isStaticAssetPath } from '../asset-paths.ts';
import { SEED_MACHINES } from '../../db/catalog-seed-data.ts';
import {
  findMachinePhotos,
  machinePhotoManifestSchema,
  parseMachinePhotoManifest,
} from './machine-photos.ts';

/**
 * What actually shipped, checked against the bytes on disk.
 *
 * `pnpm run assets:check` re-encodes the sources and compares; this suite is the second
 * half of that guarantee, run inside the normal test gate: it proves the manifest the
 * *application* imports agrees with the files the browser will request.
 */

const projectRoot = resolve(process.cwd());
const publicMachines = join(projectRoot, 'public', 'machines');
const sourceMachines = join(projectRoot, 'source-assets', 'machines');

/** The four sample JPEGs, by content. */
const EXPECTED_SOURCE_SHA256: Record<string, string> = {
  'plate-leg-press-01': '2a72839dc6ccceed0cb0e9e8bf3d72766ef56853c185799b2bc6945be7246d76',
  'seated-leg-press-01': '0792c7594f82c4a7f5ec70b4c317a4721245795e6e83e8c73a8e5d95d0181895',
  'adjustable-cable-01': '7b03a94c69e549f68388f56ffc8953793e7d81bf8d7b27b5d41cc93ec803e3d9',
  'low-row-station-01': '0cf99a1bd3228c719873bbf172ccc810cdf5e782d982dfcf5e53ccfcde7b023d',
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashesIn(directory: string): Map<string, string> {
  const hashes = new Map<string, string>();
  if (!existsSync(directory)) {
    return hashes;
  }
  for (const name of readdirSync(directory)) {
    hashes.set(name, sha256(readFileSync(join(directory, name))));
  }
  return hashes;
}

const manifest = parseMachinePhotoManifest();

describe('machine photo inventory', () => {
  it('validates against its own schema', () => {
    expect(machinePhotoManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('describes exactly the four unique photographs', () => {
    expect(manifest.machines).toHaveLength(4);
    expect(manifest.machines.map((entry) => entry.seedKey).sort()).toEqual(
      Object.keys(EXPECTED_SOURCE_SHA256).sort(),
    );
  });

  it('records the source hash the user supplied for each machine', () => {
    for (const entry of manifest.machines) {
      expect(entry.source.sha256).toBe(EXPECTED_SOURCE_SHA256[entry.seedKey]);
    }
  });

  it('deduplicates by content: no two machines share a source', () => {
    const digests = manifest.machines.map((entry) => entry.source.sha256);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('has a thumbnail and a detail variant for every machine', () => {
    for (const entry of manifest.machines) {
      expect(entry.variants.map((variant) => variant.role).sort()).toEqual(['detail', 'thumbnail']);
    }
  });
});

describe('the derivatives on disk match what the manifest claims', () => {
  const published = hashesIn(publicMachines);

  it.each(
    manifest.machines.flatMap((entry) =>
      entry.variants.map((variant) => [entry.seedKey, variant] as const),
    ),
  )('%s %s is present and unmodified', (_seedKey, variant) => {
    const fileName = variant.url.slice('/machines/'.length);
    const actual = published.get(fileName);
    expect(actual, `${fileName} is missing from public/machines`).toBeDefined();
    expect(actual).toBe(variant.sha256);

    const bytes = readFileSync(join(publicMachines, fileName));
    expect(bytes.length).toBe(variant.byteSize);
    // WebP files begin "RIFF....WEBP"; the recorded MIME type is not taken on trust.
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(variant.mimeType).toBe('image/webp');
  });

  it('publishes nothing beyond the eight expected derivatives', () => {
    const expected = manifest.machines.flatMap((entry) =>
      entry.variants.map((variant) => variant.url.slice('/machines/'.length)),
    );
    expect([...published.keys()].sort()).toEqual([...expected].sort());
  });

  it('never upscales: a derivative is never larger than the source frame', () => {
    for (const entry of manifest.machines) {
      for (const variant of entry.variants) {
        expect(variant.widthPx).toBeLessThanOrEqual(720);
        expect(variant.heightPx).toBeLessThanOrEqual(1280);
      }
    }
  });

  it('keeps the thumbnail genuinely small and the detail image larger', () => {
    for (const entry of manifest.machines) {
      const thumb = entry.variants.find((variant) => variant.role === 'thumbnail');
      const detail = entry.variants.find((variant) => variant.role === 'detail');
      expect(thumb?.byteSize).toBeLessThan(detail?.byteSize ?? 0);
      expect(Math.max(thumb?.widthPx ?? 0, thumb?.heightPx ?? 0)).toBeLessThanOrEqual(400);
    }
  });

  it('preserves each source aspect ratio rather than cropping to a square', () => {
    for (const entry of manifest.machines) {
      for (const variant of entry.variants) {
        // The sample images are 720x1280; a square thumbnail would have cut the frame.
        expect(variant.widthPx / variant.heightPx).toBeCloseTo(720 / 1280, 2);
      }
    }
  });

  it('references every derivative by a path under a served asset root', () => {
    for (const entry of manifest.machines) {
      for (const variant of entry.variants) {
        expect(isStaticAssetPath(variant.url)).toBe(true);
        expect(variant.url.startsWith('/machines/')).toBe(true);
      }
    }
  });
});

describe('sample image inventory', () => {
  it('keeps exactly the four sample JPEGs in source-assets', () => {
    const sources = hashesIn(sourceMachines);
    expect(sources.size).toBe(4);
    expect([...sources.values()].sort()).toEqual(Object.values(EXPECTED_SOURCE_SHA256).sort());
  });
});

describe('the manifest and the seed agree', () => {
  it('has a photo set for every seeded machine', () => {
    for (const definition of SEED_MACHINES) {
      expect(findMachinePhotos(manifest, definition.seedKey)).toBeDefined();
    }
    expect(SEED_MACHINES).toHaveLength(manifest.machines.length);
  });

  it('gives every machine alt text that describes the equipment without a brand', () => {
    for (const definition of SEED_MACHINES) {
      expect(definition.altText.length).toBeGreaterThan(20);
      expect(definition.altText).not.toMatch(
        /\b(technogym|life ?fitness|hammer strength|cybex|matrix|precor|nautilus)\b/i,
      );
    }
  });

  it('rejects a hand-edited manifest instead of seeding a wrong dimension', () => {
    const tampered = {
      ...manifest,
      machines: [
        {
          ...manifest.machines[0],
          variants: [{ ...manifest.machines[0]?.variants[0], widthPx: 0 }],
        },
      ],
    };
    expect(() => parseMachinePhotoManifest(tampered)).toThrow();
    expect(() => parseMachinePhotoManifest({ ...manifest, machines: [] })).toThrow();
  });
});
