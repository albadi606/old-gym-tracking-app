import { describe, expect, it } from 'vitest';

import { canonicalJson, CanonicalizationError } from './canonical.ts';

describe('canonical JSON', () => {
  it('orders object keys, so two builds hash the same value identically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('orders keys at every depth, not only the top', () => {
    const left = { outer: { z: [{ b: 1, a: 2 }], a: 1 } };
    const right = { outer: { a: 1, z: [{ a: 2, b: 1 }] } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('preserves array order, because an array is not a set', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('omits an absent value exactly as JSON.stringify does', () => {
    // This is what makes the digest computed before writing equal the digest computed
    // after parsing: the parsed object simply has no such key.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it('survives a real round trip through JSON text', () => {
    const value = {
      note: 'a note with "quotes", a newline\n and an emoji 🏋',
      nested: [{ z: null, a: [1.5, -0, 1e21, 0.1] }],
    };
    expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(canonicalJson(value));
  });

  it('writes null for a hole in an array, as JSON does', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('refuses what JSON cannot carry rather than hashing a lie', () => {
    // Hashing `{}` in place of a Blob would produce a digest that verifies a file the
    // application cannot actually read back.
    expect(() => canonicalJson({ blob: new Blob(['x']) })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ fn: () => undefined })).toThrow(CanonicalizationError);
  });

  it('names where the problem was, without printing the value', () => {
    try {
      canonicalJson({ data: { mediaAssets: [{ blob: new Blob(['x']) }] } });
      expect.unreachable('canonicalJson should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError);
      expect((error as CanonicalizationError).path).toBe('data.mediaAssets[0].blob');
    }
  });
});
