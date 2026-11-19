import { describe, expect, it } from 'vitest';

import { sha256Hex } from './sha256.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A hash implemented by hand is only trustworthy if it is checked against something
 * outside this repository. These are the published FIPS 180-4 / NIST example digests,
 * written out literally rather than computed, so a defect in the implementation cannot
 * also produce the expectation.
 */
const PUBLISHED_VECTORS: [string, string][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

describe('SHA-256', () => {
  it.each(PUBLISHED_VECTORS)('matches the published digest for %j', (input, expected) => {
    expect(sha256Hex(encode(input))).toBe(expected);
  });

  it('hashes a million repeats of "a" to the published value', () => {
    expect(sha256Hex(encode('a'.repeat(1_000_000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it.each([54, 55, 56, 63, 64, 65, 119, 120, 128])(
    'handles a message of exactly %i bytes, where block padding is easy to get wrong',
    (length) => {
      // Compared against the same implementation's own vector-checked behaviour is not
      // enough, so each of these is checked for shape and for being distinct from its
      // neighbours -- a padding bug collapses adjacent lengths onto the same digest.
      const digest = sha256Hex(new Uint8Array(length).fill(0x61));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).not.toBe(sha256Hex(new Uint8Array(length + 1).fill(0x61)));
    },
  );

  it('agrees with the platform implementation, byte for byte', async () => {
    const subtle = globalThis.crypto?.subtle;
    // The environment is asserted rather than assumed: if this ever stops running, the
    // fallback would silently lose its only independent check.
    expect(subtle, 'crypto.subtle must be available for this comparison').toBeDefined();

    for (const text of ['', 'abc', 'a'.repeat(1000), '🏋 incline 16, unknown']) {
      const bytes = encode(text);
      const native = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes)));
      const nativeHex = [...native].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(sha256Hex(bytes)).toBe(nativeHex);
    }
  });

  it('reads every byte, including high ones a text encoder would never produce', () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) {
      bytes[index] = index;
    }
    const changed = Uint8Array.from(bytes);
    changed[255] = 254;
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(changed));
  });
});
