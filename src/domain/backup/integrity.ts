import { canonicalJson } from './canonical.ts';
import { sha256Hex } from './sha256.ts';

/**
 * The backup envelope's integrity checksum.
 *
 * ## What it is
 *
 * A SHA-256 digest over a deterministic text of everything in the envelope except the
 * checksum itself. It detects a file that changed after it was written: a truncated
 * download, a byte flipped by failing storage, an edited note, a swapped photo -- including
 * the case where a photo's base64 is replaced by *different, still-valid,
 * exactly-as-long* base64, which no length or shape check can see.
 *
 * ## What it is not
 *
 * It is not encryption: the file is readable by anyone who has it. It is not
 * authentication: there is no key, so it says nothing about who produced the file. And it
 * cannot stop someone who is deliberately modifying the backup, because they can rewrite
 * the digest as easily as the payload. Those limits are stated in the app's own copy, not
 * only here, because a checksum described as protection is worse than none.
 */

/** Recorded in the envelope so a later algorithm can be introduced without ambiguity. */
export const INTEGRITY_ALGORITHM = 'SHA-256';
export type IntegrityAlgorithm = typeof INTEGRITY_ALGORITHM;

/** 64 lower-case hexadecimal characters. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

async function nativeDigest(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return undefined;
  }
  try {
    // A fresh buffer: `bytes` may be a view onto a larger one, and `digest` hashes the
    // whole buffer it is handed.
    const copy = new Uint8Array(bytes);
    const hashed = await subtle.digest('SHA-256', copy);
    return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // An insecure origin, or a browser that refuses. The pure implementation produces the
    // same digest, so the file is still written with a valid checksum.
    return undefined;
  }
}

/**
 * The digest of a JSON value, over its canonical text.
 *
 * Native where available and the identical pure implementation otherwise; `integrity.test.ts`
 * proves the two agree, so which path ran can never change whether a file verifies.
 */
export async function digestOfJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return (await nativeDigest(bytes)) ?? sha256Hex(bytes);
}

/**
 * Compares two digests without leaking which character differed through timing.
 *
 * There is no secret here to protect, so this is belt and braces rather than a
 * requirement; it costs nothing and removes the question.
 */
export function digestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
