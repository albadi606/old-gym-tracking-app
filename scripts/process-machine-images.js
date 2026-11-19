/**
 * Deterministic machine-photo pipeline.
 *
 * `--build` regenerates the served derivatives and the manifest the catalog seed reads.
 * `--check` (the default, and the one wired into the gates) re-verifies everything
 * without writing, so a stale or hand-edited asset fails a gate instead of shipping.
 *
 * The sample sources are verified by SHA-256. Dimensions, MIME type, and size are read
 * back from the encoded assets.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import sharp from 'sharp';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'source-assets', 'machines');
const outputDir = join(projectRoot, 'public', 'machines');
const manifestPath = join(projectRoot, 'src', 'domain', 'catalog', 'machine-photo-manifest.json');

/** The four sample equipment images. */
const SOURCES = [
  { seedKey: 'plate-leg-press-01', file: 'plate-leg-press-01.jpg' },
  { seedKey: 'seated-leg-press-01', file: 'seated-leg-press-01.jpg' },
  { seedKey: 'adjustable-cable-01', file: 'adjustable-cable-01.jpg' },
  { seedKey: 'low-row-station-01', file: 'low-row-station-01.jpg' },
];

const EXPECTED_SOURCE_SHA256 = {
  'plate-leg-press-01': '2a72839dc6ccceed0cb0e9e8bf3d72766ef56853c185799b2bc6945be7246d76',
  'seated-leg-press-01': '0792c7594f82c4a7f5ec70b4c317a4721245795e6e83e8c73a8e5d95d0181895',
  'adjustable-cable-01': '7b03a94c69e549f68388f56ffc8953793e7d81bf8d7b27b5d41cc93ec803e3d9',
  'low-row-station-01': '0cf99a1bd3228c719873bbf172ccc810cdf5e782d982dfcf5e53ccfcde7b023d',
};

/**
 * Variants. `fit: 'inside'` with `withoutEnlargement` preserves the whole frame and the
 * aspect ratio: a square crop would cut the seat or the stack off a portrait photo, and
 * upscaling would invent detail the original does not contain.
 */
const VARIANTS = [
  { role: 'thumbnail', suffix: 'thumb', maxWidth: 400, maxHeight: 400, quality: 72 },
  { role: 'detail', suffix: 'detail', maxWidth: 900, maxHeight: 1600, quality: 82 },
];

const OUTPUT_MIME_TYPE = 'image/webp';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function outputFileName(seedKey, suffix) {
  return `${seedKey}-${suffix}.webp`;
}

function outputUrl(seedKey, suffix) {
  return `/machines/${outputFileName(seedKey, suffix)}`;
}

/** Reads and hash-verifies the four sample images. Throws on any mismatch. */
function readVerifiedSources() {
  const seen = new Map();
  return SOURCES.map(({ seedKey, file }) => {
    const path = join(sourceDir, file);
    if (!existsSync(path)) {
      throw new Error(`Missing source image: source-assets/machines/${file}`);
    }
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    const expected = EXPECTED_SOURCE_SHA256[seedKey];
    if (digest !== expected) {
      throw new Error(`Source ${file} has SHA-256 ${digest}; expected ${expected}`);
    }
    const duplicateOf = seen.get(digest);
    if (duplicateOf) {
      throw new Error(
        `Source ${file} is byte-identical to ${duplicateOf}; it is not a new machine`,
      );
    }
    seen.set(digest, file);
    return { seedKey, file, bytes, sha256: digest, byteSize: bytes.length };
  });
}

/**
 * Encodes one variant and reports what was actually produced.
 *
 * `rotate()` with no argument applies the EXIF orientation and then drops it, so the
 * stored pixels are already upright; sharp writes no metadata unless asked, so the
 * derivative carries no camera or location tags.
 */
async function encodeVariant(sourceBytes, variant) {
  const buffer = await sharp(sourceBytes)
    .rotate()
    .resize({
      width: variant.maxWidth,
      height: variant.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: variant.quality })
    .toBuffer();

  // Read the geometry back out of the encoded result rather than predicting it.
  const produced = await sharp(buffer).metadata();
  if (produced.format !== 'webp') {
    throw new Error(`Encoder produced ${String(produced.format)}, expected webp`);
  }
  return {
    bytes: buffer,
    widthPx: produced.width,
    heightPx: produced.height,
    byteSize: buffer.length,
    sha256: sha256(buffer),
  };
}

async function buildManifest() {
  const sources = readVerifiedSources();
  const entries = [];

  for (const source of sources) {
    const variants = {};
    for (const variant of VARIANTS) {
      const encoded = await encodeVariant(source.bytes, variant);
      variants[variant.role] = {
        role: variant.role,
        url: outputUrl(source.seedKey, variant.suffix),
        mimeType: OUTPUT_MIME_TYPE,
        widthPx: encoded.widthPx,
        heightPx: encoded.heightPx,
        byteSize: encoded.byteSize,
        sha256: encoded.sha256,
        bytes: encoded.bytes,
      };
    }
    entries.push({
      seedKey: source.seedKey,
      source: { file: source.file, sha256: source.sha256, byteSize: source.byteSize },
      variants,
    });
  }

  return entries;
}

/** Manifest shape written to disk: the mechanical facts only, no image bytes. */
function toManifestJson(entries) {
  return {
    generatedBy: 'scripts/process-machine-images.js',
    outputMimeType: OUTPUT_MIME_TYPE,
    machines: entries.map((entry) => ({
      seedKey: entry.seedKey,
      source: entry.source,
      variants: VARIANTS.map((variant) => {
        const produced = entry.variants[variant.role];
        return {
          role: produced.role,
          url: produced.url,
          mimeType: produced.mimeType,
          widthPx: produced.widthPx,
          heightPx: produced.heightPx,
          byteSize: produced.byteSize,
          sha256: produced.sha256,
        };
      }),
    })),
  };
}

/** Nothing but the eight expected derivatives may sit in the served asset folder. */
function unexpectedOutputFiles(expectedNames) {
  if (!existsSync(outputDir)) {
    return [];
  }
  return readdirSync(outputDir).filter((name) => !expectedNames.has(name));
}

async function runBuild() {
  const entries = await buildManifest();
  mkdirSync(outputDir, { recursive: true });

  for (const entry of entries) {
    for (const variant of VARIANTS) {
      const produced = entry.variants[variant.role];
      writeFileSync(join(outputDir, outputFileName(entry.seedKey, variant.suffix)), produced.bytes);
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify(toManifestJson(entries), null, 2)}\n`, 'utf8');
  console.log(`Wrote ${String(entries.length * VARIANTS.length)} derivatives to public/machines`);
  console.log('Wrote src/domain/catalog/machine-photo-manifest.json');
  return 0;
}

async function runCheck() {
  const problems = [];
  let entries;
  try {
    entries = await buildManifest();
  } catch (error) {
    console.error(`Source verification failed: ${error.message}`);
    return 1;
  }

  if (!existsSync(manifestPath)) {
    console.error(
      'Missing src/domain/catalog/machine-photo-manifest.json. Run pnpm run assets:build.',
    );
    return 1;
  }

  const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expected = toManifestJson(entries);
  if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
    problems.push('machine-photo-manifest.json does not match a fresh encode of the sources');
  }

  const expectedNames = new Set();
  for (const entry of entries) {
    for (const variant of VARIANTS) {
      const produced = entry.variants[variant.role];
      const name = outputFileName(entry.seedKey, variant.suffix);
      expectedNames.add(name);
      const path = join(outputDir, name);
      if (!existsSync(path)) {
        problems.push(`Missing derivative public/machines/${name}`);
        continue;
      }
      const actual = readFileSync(path);
      if (sha256(actual) !== produced.sha256) {
        problems.push(`public/machines/${name} does not match a fresh encode of its source`);
      }
    }
  }

  for (const name of unexpectedOutputFiles(expectedNames)) {
    problems.push(`Unexpected file in public/machines: ${name}`);
  }

  const sourceFiles = existsSync(sourceDir) ? readdirSync(sourceDir) : [];
  if (sourceFiles.length !== SOURCES.length) {
    problems.push(
      `source-assets/machines holds ${String(sourceFiles.length)} files; expected exactly ${String(SOURCES.length)}`,
    );
  }

  if (problems.length > 0) {
    console.error('Machine asset check failed:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    return 1;
  }

  console.log(
    `Machine assets verified: ${String(entries.length)} sources, ${String(expectedNames.size)} derivatives, manifest current.`,
  );
  return 0;
}

const mode = process.argv.includes('--build') ? 'build' : 'check';
const exitCode = mode === 'build' ? await runBuild() : await runCheck();
process.exitCode = exitCode;
