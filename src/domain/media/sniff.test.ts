import { describe, expect, it } from 'vitest';

import { sniffImageMimeType } from './sniff.ts';

function bytes(...values: (number | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') {
      flat.push(value);
    } else {
      for (const character of value) {
        flat.push(character.charCodeAt(0));
      }
    }
  }
  return Uint8Array.from(flat);
}

const PNG_HEADER = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG_HEADER = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0);
const WEBP_HEADER = bytes('RIFF', 0x24, 0, 0, 0, 'WEBP', 'VP8 ');
const AVIF_HEADER = bytes(0, 0, 0, 0x1c, 'ftyp', 'avif', 0, 0, 0, 0);

describe('reading a format from the bytes themselves', () => {
  it.each([
    ['PNG', PNG_HEADER, 'image/png'],
    ['JPEG', JPEG_HEADER, 'image/jpeg'],
    ['WebP', WEBP_HEADER, 'image/webp'],
    ['AVIF', AVIF_HEADER, 'image/avif'],
  ])('recognises %s', (_label, input, expected) => {
    expect(sniffImageMimeType(input)).toBe(expected);
  });

  it('recognises the AVIF sequence brand too', () => {
    expect(sniffImageMimeType(bytes(0, 0, 0, 0x1c, 'ftyp', 'avis', 0, 0))).toBe('image/avif');
  });

  it('refuses a format this app does not store, whatever the file is called', () => {
    // SVG is excluded deliberately: it can carry script.
    expect(sniffImageMimeType(bytes('<svg xmlns='))).toBeUndefined();
    expect(sniffImageMimeType(bytes('%PDF-1.7'))).toBeUndefined();
    expect(sniffImageMimeType(bytes('GIF89a'))).toBeUndefined();
    expect(sniffImageMimeType(bytes('MZ', 0x90, 0))).toBeUndefined();
    expect(sniffImageMimeType(bytes('BM', 0, 0))).toBeUndefined();
  });

  it('refuses bytes that are too short to carry a signature', () => {
    expect(sniffImageMimeType(new Uint8Array(0))).toBeUndefined();
    expect(sniffImageMimeType(bytes(0x89, 'PN'))).toBeUndefined();
    expect(sniffImageMimeType(bytes('RIFF', 0, 0, 0))).toBeUndefined();
  });

  it('refuses a RIFF container that is not WebP', () => {
    expect(sniffImageMimeType(bytes('RIFF', 0x24, 0, 0, 0, 'WAVE'))).toBeUndefined();
  });

  it('refuses an ISO-BMFF file whose brand is not an image', () => {
    expect(sniffImageMimeType(bytes(0, 0, 0, 0x1c, 'ftyp', 'mp42', 0, 0))).toBeUndefined();
  });
});
