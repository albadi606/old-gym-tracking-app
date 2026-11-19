/**
 * One deterministic text for one JSON value.
 *
 * A checksum is only useful if both sides agree, byte for byte, on what was hashed.
 * `JSON.stringify` does not give that: it preserves whichever key order the object
 * happened to have, and an object read back from a file can easily have another. So the
 * digest is taken over this representation instead -- keys sorted, no whitespace, and
 * absent values genuinely absent.
 *
 * The rules are chosen to survive a real round trip through a file:
 *
 * - **Object keys are sorted by code unit**, which is the one ordering both an exporting
 *   build and an importing build can reach without agreeing on anything else.
 * - **A property whose value is `undefined` is omitted**, exactly as `JSON.stringify`
 *   omits it. This is what makes the digest computed before writing the file equal the
 *   digest computed after parsing it: the parsed object simply has no such key.
 * - **Numbers use `JSON.stringify`'s own shortest round-tripping form**, so a value
 *   written and re-read produces the same text. `-0` becomes `0`, as it does in JSON.
 * - **Anything JSON cannot carry throws.** A `Blob`, a function, a `Symbol`, `NaN`, or an
 *   infinity in the payload is a bug in the caller, and silently hashing `{}` in its place
 *   would produce a digest that verifies a file the app cannot read.
 */

const NON_FINITE = 'Cannot canonicalize a non-finite number';

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path || '(root)'}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(NON_FINITE, path);
      }
      // `JSON.stringify` of a finite number is the shortest text that parses back to it.
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`Cannot canonicalize a ${typeof value}`, path);
  }

  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index > 0) {
        out.push(',');
      }
      // A hole or an explicit `undefined` in an array is `null` in JSON; matching that
      // keeps the digest equal to what a re-read of the written file produces.
      write(item === undefined ? null : item, `${path}[${String(index)}]`, out);
    });
    out.push(']');
    return;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.getPrototypeOf(record) !== Object.prototype &&
    Object.getPrototypeOf(record) !== null
  ) {
    throw new CanonicalizationError('Cannot canonicalize a non-plain object', path);
  }

  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  out.push('{');
  keys.forEach((key, index) => {
    if (index > 0) {
      out.push(',');
    }
    out.push(JSON.stringify(key), ':');
    write(record[key], path ? `${path}.${key}` : key, out);
  });
  out.push('}');
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, '', out);
  return out.join('');
}
