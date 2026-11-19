import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical.ts';
import { digestOfJson, digestsMatch, DIGEST_PATTERN, INTEGRITY_ALGORITHM } from './integrity.ts';
import { sha256Hex } from './sha256.ts';

const realSubtle = globalThis.crypto.subtle;

function withoutSubtle(): void {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: undefined,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: realSubtle,
  });
});

const SAMPLE = {
  data: {
    workoutSessions: [{ id: 'a', name: 'Test workout', notes: 'incline 16 — unknown 🏋' }],
    mediaAssets: [{ data: 'AAAB', byteSize: 3 }],
  },
  exportedAt: '2026-08-28T05:00:00.000Z',
};

describe('the backup digest', () => {
  it('names its algorithm, so a later one can be introduced unambiguously', () => {
    expect(INTEGRITY_ALGORITHM).toBe('SHA-256');
  });

  it('is 64 lower-case hexadecimal characters', async () => {
    expect(await digestOfJson(SAMPLE)).toMatch(DIGEST_PATTERN);
  });

  it('does not depend on key order', async () => {
    const reordered = { exportedAt: SAMPLE.exportedAt, data: SAMPLE.data };
    expect(await digestOfJson(reordered)).toBe(await digestOfJson(SAMPLE));
  });

  it('changes when any byte of the payload changes', async () => {
    const original = await digestOfJson(SAMPLE);
    const edited = JSON.parse(JSON.stringify(SAMPLE)) as typeof SAMPLE;
    edited.data.workoutSessions[0]!.notes = 'incline 16 — unknown 🏋 ';
    expect(await digestOfJson(edited)).not.toBe(original);
  });

  it('changes when a same-length, still-valid base64 payload is substituted', async () => {
    // The case a length check and a shape check both miss entirely.
    const original = await digestOfJson(SAMPLE);
    const swapped = JSON.parse(JSON.stringify(SAMPLE)) as typeof SAMPLE;
    swapped.data.mediaAssets[0]!.data = 'AAAC';
    expect(swapped.data.mediaAssets[0]!.data.length).toBe(4);
    expect(await digestOfJson(swapped)).not.toBe(original);
  });

  /**
   * The whole point of keeping a pure implementation: which path ran must never decide
   * whether a file verifies. A build that exports on a machine with `crypto.subtle` and
   * imports on one without it has to reach the same answer.
   */
  it('produces the same digest with and without crypto.subtle', async () => {
    const native = await digestOfJson(SAMPLE);
    withoutSubtle();
    const fallback = await digestOfJson(SAMPLE);
    expect(fallback).toBe(native);
    expect(fallback).toBe(sha256Hex(new TextEncoder().encode(canonicalJson(SAMPLE))));
  });

  it('still produces a digest when crypto.subtle throws', async () => {
    const native = await digestOfJson(SAMPLE);
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: {
        digest: () => {
          throw new Error('SecurityError');
        },
      },
    });
    expect(await digestOfJson(SAMPLE)).toBe(native);
  });
});

describe('comparing digests', () => {
  it('matches identical digests and nothing else', () => {
    const digest = 'a'.repeat(64);
    expect(digestsMatch(digest, digest)).toBe(true);
    expect(digestsMatch(digest, `${'a'.repeat(63)}b`)).toBe(false);
    expect(digestsMatch(digest, 'a'.repeat(63))).toBe(false);
    expect(digestsMatch('', '')).toBe(true);
  });
});
