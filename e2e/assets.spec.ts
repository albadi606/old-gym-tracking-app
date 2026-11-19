import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the production build actually contains.
 *
 * `pnpm run assets:check` verifies the sources and derivatives before the build; this
 * runs after it, because only `dist/` can answer the question that matters most: did
 * anything reach the shipped bundle that should never have left the workspace?
 */

const projectRoot = process.cwd();
const dist = join(projectRoot, 'dist');

const EXPECTED_DERIVATIVES = [
  'adjustable-cable-01-detail.webp',
  'adjustable-cable-01-thumb.webp',
  'low-row-station-01-detail.webp',
  'low-row-station-01-thumb.webp',
  'plate-leg-press-01-detail.webp',
  'plate-leg-press-01-thumb.webp',
  'seated-leg-press-01-detail.webp',
  'seated-leg-press-01-thumb.webp',
];

interface DistFile {
  path: string;
  relative: string;
}

function walk(directory: string, into: DistFile[] = [], base = directory): DistFile[] {
  if (!existsSync(directory)) {
    return into;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, into, base);
      continue;
    }
    into.push({
      path,
      relative: path.slice(base.length + 1).replaceAll('\\', '/'),
    });
  }
  return into;
}

test.describe('the production bundle', () => {
  test('ships the eight derivatives and nothing else under /machines', () => {
    expect(existsSync(dist), 'dist/ should exist after the build').toBe(true);
    const machines = join(dist, 'machines');
    expect(readdirSync(machines).sort()).toEqual(EXPECTED_DERIVATIVES);
  });

  test('does not ship the untouched originals', () => {
    const files = walk(dist);
    // The sources are JPEGs; only normalized WebP derivatives belong in the bundle.
    const jpegs = files.filter((file) => /\.jpe?g$/i.test(file.relative));
    expect(jpegs.map((file) => file.relative)).toEqual([]);
    expect(files.some((file) => file.relative.startsWith('source-assets'))).toBe(false);
  });

  test('keeps every shipped photo small enough to load on a phone', () => {
    for (const name of EXPECTED_DERIVATIVES) {
      const bytes = statSync(join(dist, 'machines', name)).size;
      expect(bytes, name).toBeGreaterThan(0);
      expect(bytes, name).toBeLessThan(200 * 1024);
    }
  });

  test('serves each derivative over HTTP as a WebP image', async ({ request }) => {
    for (const name of EXPECTED_DERIVATIVES) {
      const response = await request.get(`/machines/${name}`);
      expect(response.status(), name).toBe(200);
      expect(response.headers()['content-type'], name).toContain('image/webp');
    }
  });

  test('does not serve the source originals over HTTP', async ({ request }) => {
    const response = await request.get('/source-assets/machines/low-row-station-01.jpg');
    // The SPA fallback returns index.html for unknown paths; what matters is that no
    // JPEG is served from this address.
    expect(response.headers()['content-type'] ?? '').not.toContain('image/jpeg');
  });
});
