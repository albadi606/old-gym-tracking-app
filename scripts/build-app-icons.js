/**
 * The application's own icons.
 *
 * `--build` renders the PNGs an installed Gym Tracker uses; `--check` (the default)
 * re-renders them in memory and fails if a shipped file has drifted, so a hand-edited or
 * stale icon cannot ship unnoticed. This mirrors `process-machine-images.js`, and for the
 * same reason: an asset nothing verifies is an asset that quietly rots.
 *
 * The artwork is drawn here, in code, from rectangles and rounded corners. It is original
 * to this project. The equipment images are *not* used as a logo -- they are
 * identification references for specific equipment, and the third-party technique image
 * has unconfirmed reuse rights, so neither may become the app's mark.
 *
 * Two purposes are produced from one glyph:
 *
 * - `any`: the mark on the app's canvas colour, with breathing room at the edges.
 * - `maskable`: the same mark on a full-bleed background, drawn well inside the centre
 *   80% circle that Android and other launchers may crop to. A maskable icon that
 *   reuses the `any` artwork loses its edges the moment a launcher applies a circle.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import sharp from 'sharp';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(projectRoot, 'public', 'icons');

/** Straight from `src/styles/tokens.css`, so the installed icon matches the app. */
const CANVAS = '#14171c';
const ACCENT = '#35c9a4';

/**
 * The mark: a barbell, drawn on a 100x100 grid and scaled by the caller.
 *
 * `inset` is how much of the square the glyph leaves empty on every side. The maskable
 * variant uses a larger inset so the whole mark survives a circular crop.
 */
function glyph(inset) {
  const span = 100 - inset * 2;
  const unit = span / 100;
  const x = (value) => (inset + value * unit).toFixed(3);
  const y = x;
  const size = (value) => (value * unit).toFixed(3);

  return [
    // The bar.
    `<rect x="${x(8)}" y="${y(44)}" width="${size(84)}" height="${size(12)}" rx="${size(6)}" fill="${ACCENT}"/>`,
    // Inner plates.
    `<rect x="${x(24)}" y="${y(26)}" width="${size(14)}" height="${size(48)}" rx="${size(6)}" fill="${ACCENT}"/>`,
    `<rect x="${x(62)}" y="${y(26)}" width="${size(14)}" height="${size(48)}" rx="${size(6)}" fill="${ACCENT}"/>`,
    // Outer plates, shorter, so the silhouette reads as a barbell at 48px too.
    `<rect x="${x(6)}" y="${y(34)}" width="${size(12)}" height="${size(32)}" rx="${size(5)}" fill="${ACCENT}"/>`,
    `<rect x="${x(82)}" y="${y(34)}" width="${size(12)}" height="${size(32)}" rx="${size(5)}" fill="${ACCENT}"/>`,
  ].join('');
}

/** Corner radius in viewBox units. A maskable icon must stay square and full-bleed. */
const ROUNDED_RADIUS = 20;

function svg({ size, inset, rounded }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
<rect x="0" y="0" width="100" height="100" rx="${rounded ? ROUNDED_RADIUS : 0}" fill="${CANVAS}"/>
${glyph(inset)}
</svg>`;
}

/**
 * Every icon this project ships.
 *
 * `inset` for the maskable icon keeps the mark inside a centred circle of 80% diameter,
 * which is the safe area launchers guarantee.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 14, rounded: true, purpose: 'any' },
  { file: 'icon-512.png', size: 512, inset: 14, rounded: true, purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, inset: 26, rounded: false, purpose: 'maskable' },
];

async function render(icon) {
  return sharp(Buffer.from(svg(icon)), { density: 384 })
    .resize(icon.size, icon.size, { fit: 'fill' })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const mode = process.argv.includes('--build') ? 'build' : 'check';
  if (mode === 'build') {
    mkdirSync(outputDir, { recursive: true });
  }

  const problems = [];
  for (const icon of ICONS) {
    const rendered = await render(icon);
    const path = join(outputDir, icon.file);

    if (mode === 'build') {
      writeFileSync(path, rendered);
      continue;
    }

    if (!existsSync(path)) {
      problems.push(`${icon.file}: missing. Run "pnpm run icons:build".`);
      continue;
    }
    const onDisk = readFileSync(path);
    if (sha256(onDisk) !== sha256(rendered)) {
      problems.push(`${icon.file}: does not match what this script renders.`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    mode === 'build'
      ? `Application icons written: ${ICONS.length} files in public/icons.`
      : `Application icons verified: ${ICONS.length} files, all current.`,
  );
}

await main();
