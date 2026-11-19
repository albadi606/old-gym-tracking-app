/**
 * Base64 for the JSON backup file only.
 *
 * Photos live in IndexedDB as Blobs at rest. A backup is a JSON document, which cannot
 * carry a Blob at all -- `JSON.stringify(blob)` produces `{}` and silently loses the
 * image -- so bytes are encoded on the way out and decoded on the way back in.
 */

/**
 * Encoded in small slices: spreading a multi-megabyte array into `String.fromCharCode`
 * exhausts the call stack, so the chunk stays well inside every engine's argument limit.
 */
const CHUNK_SIZE = 0x1000;

/**
 * A single character class, deliberately: a grouped `(?:....){4}*` pattern backtracks
 * and overflows the stack on a multi-megabyte photo. `=` is absent from the class, so
 * padding can only appear where the trailing `={0,2}` allows it.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Returns `undefined` rather than throwing, so a corrupt backup fails closed. */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!isBase64(value)) {
    return undefined;
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
