import type { SupportedImageMimeType } from '../enums.ts';

/**
 * What an image really is, read from its own first bytes.
 *
 * The standing rule in this project is that supplied metadata is a claim. A filename, an
 * extension, a browser-reported MIME type, and a `mimeType` field inside an imported
 * backup are all things somebody else wrote down. The bytes are the fact, and every
 * format below announces itself in a fixed signature at a fixed offset.
 *
 * This is deliberately not a full container parser. It answers one question -- "which of
 * the four formats this app stores does this claim to be, by its own header" -- and the
 * import path pairs it with a real decode, because a correct eight-byte PNG signature
 * followed by rubbish is still not a picture. SVG is absent on purpose: it can carry
 * script, so it is not a format this app stores at all.
 */

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const FTYP = [0x66, 0x74, 0x79, 0x70];

/** ISO-BMFF brands that mean "this is an AVIF image". */
const AVIF_BRANDS = ['avif', 'avis'];

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) {
    return '';
  }
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}

/** The format these bytes declare themselves to be, or `undefined` for anything else. */
export function sniffImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
  if (startsWith(bytes, PNG)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return 'image/webp';
  }
  if (startsWith(bytes, FTYP, 4) && AVIF_BRANDS.includes(readAscii(bytes, 8, 4))) {
    return 'image/avif';
  }
  return undefined;
}
