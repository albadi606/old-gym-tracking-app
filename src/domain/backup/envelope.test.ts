import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../db/migrations.ts';
import {
  EMPTY_BACKUP_DATA,
  makeBackupSession,
  signEnvelope,
  signThenTamper,
  TEST_APP_VERSION,
  testUuid,
} from '../../test/backup.ts';
import { FIXED_NOW } from '../../test/fixtures.ts';
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupData,
  type BackupReadResult,
  createBackupEnvelope,
  MIN_SUPPORTED_SCHEMA_VERSION,
  readBackupEnvelope,
} from './envelope.ts';
import { MAX_RECORDS } from './limits.ts';

const NOW = FIXED_NOW;

const META = {
  exportedAt: NOW,
  appVersion: TEST_APP_VERSION,
  appSchemaVersion: CURRENT_SCHEMA_VERSION,
};

describe('building a backup envelope', () => {
  it('stamps the format, the version, and a digest of its own contents', async () => {
    const envelope = await createBackupEnvelope(EMPTY_BACKUP_DATA, META);

    expect(envelope.format).toBe(BACKUP_FORMAT);
    expect(envelope.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(envelope.appSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(envelope.integrity.algorithm).toBe('SHA-256');
    expect(envelope.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a file this build reads back', async () => {
    const envelope = await createBackupEnvelope(EMPTY_BACKUP_DATA, META);
    const read = await readBackupEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(read.status).toBe('ok');
  });

  it('is deterministic: the same data twice produces the same digest', async () => {
    const first = await createBackupEnvelope(EMPTY_BACKUP_DATA, META);
    const second = await createBackupEnvelope(EMPTY_BACKUP_DATA, META);
    expect(second.integrity.digest).toBe(first.integrity.digest);
  });

  it('refuses to write a file it could not read back', async () => {
    const broken = {
      ...EMPTY_BACKUP_DATA,
      machines: [{ id: 'not-a-uuid' }],
    } as unknown as BackupData;
    await expect(createBackupEnvelope(broken, META)).rejects.toThrow();
  });
});

describe('reading a backup envelope', () => {
  it('accepts a well-formed current-version backup', async () => {
    expect((await readBackupEnvelope(await signEnvelope())).status).toBe('ok');
  });

  it('reports an unrecognised file instead of guessing', async () => {
    expect((await readBackupEnvelope({ some: 'json' })).status).toBe('unrecognized_format');
    expect((await readBackupEnvelope('not json at all')).status).toBe('unrecognized_format');
    expect((await readBackupEnvelope(null)).status).toBe('unrecognized_format');
    expect(
      (await readBackupEnvelope(await signThenTamper({}, (e) => (e.format = 'other-app-backup'))))
        .status,
    ).toBe('unrecognized_format');
  });

  it('fails closed on a newer schema version without inspecting the payload', async () => {
    const result = await readBackupEnvelope({
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION + 1,
      data: { nonsense: true },
    });
    expect(result).toEqual({
      status: 'unsupported_version',
      schemaVersion: BACKUP_SCHEMA_VERSION + 1,
      supportedVersion: BACKUP_SCHEMA_VERSION,
    });
  });

  /**
   * Version 1 was a contract only: no build ever shipped an export, so no such file can
   * exist. Refusing it keeps the app from ever having a code path that imports without
   * verifying a digest, and the refusal is named so the user is told which it was.
   */
  it('refuses a pre-integrity version by name rather than as corruption', async () => {
    const result = await readBackupEnvelope(await signEnvelope({ schemaVersion: 1 }));
    expect(result).toEqual({
      status: 'unsupported_legacy_version',
      schemaVersion: 1,
      supportedVersion: BACKUP_SCHEMA_VERSION,
    });
    expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(2);
  });

  it('reports validation issues for a corrupt payload rather than importing part of it', async () => {
    const result = await readBackupEnvelope(
      await signEnvelope({
        data: { ...EMPTY_BACKUP_DATA, machines: [{ id: 'not-a-uuid' }] } as unknown as BackupData,
      }),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects a truncated envelope that is missing whole tables', async () => {
    const { machines: _machines, ...missingTable } = EMPTY_BACKUP_DATA;
    const result = await readBackupEnvelope(
      await signEnvelope({ data: missingTable as unknown as BackupData }),
    );
    expect(result.status).toBe('invalid');
  });

  it('rejects an unknown extra top-level field', async () => {
    const result = await readBackupEnvelope(
      await signThenTamper({}, (envelope) => {
        envelope.extra = true;
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('rejects an unknown extra field inside a record', async () => {
    const result = await readBackupEnvelope(
      await signEnvelope({
        data: {
          ...EMPTY_BACKUP_DATA,
          workoutSessions: [{ ...makeBackupSession(), surprise: true } as never],
        },
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('rejects a file with no integrity block at all', async () => {
    const result = await readBackupEnvelope(
      await signThenTamper({}, (envelope) => {
        delete envelope.integrity;
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('rejects an integrity block naming an algorithm this build does not compute', async () => {
    const result = await readBackupEnvelope(
      await signThenTamper({}, (envelope) => {
        envelope.integrity = { algorithm: 'MD5', digest: 'a'.repeat(64) };
      }),
    );
    expect(result.status).toBe('invalid');
  });
});

describe('integrity verification', () => {
  it('rejects a record edited after the file was written', async () => {
    const tampered = await signThenTamper(
      { data: { ...EMPTY_BACKUP_DATA, workoutSessions: [makeBackupSession()] } },
      (envelope) => {
        const data = envelope.data as BackupData;
        data.workoutSessions[0]!.name = 'Something else';
      },
    );
    expect((await readBackupEnvelope(tampered)).status).toBe('integrity_failed');
  });

  it('rejects a same-length, still-valid base64 substitution in a photo', async () => {
    const photo = {
      id: testUuid(70),
      kind: 'user_photo',
      storageKind: 'indexeddb_blob',
      role: 'detail',
      mimeType: 'image/png',
      widthPx: 4,
      heightPx: 4,
      byteSize: 3,
      altText: 'A photo added on a test device.',
      createdAt: NOW,
      updatedAt: NOW,
      encoding: 'base64',
      data: 'AAAB',
    };
    const tampered = await signThenTamper(
      { data: { ...EMPTY_BACKUP_DATA, mediaAssets: [photo as never] } },
      (envelope) => {
        const data = envelope.data as { mediaAssets: { data: string }[] };
        // Same length, still valid base64, still decodes to three bytes: nothing but the
        // digest can tell that these are not the bytes that were exported.
        data.mediaAssets[0]!.data = 'AAAC';
      },
    );
    expect((await readBackupEnvelope(tampered)).status).toBe('integrity_failed');
  });

  it('rejects a changed export timestamp, not only a changed record', async () => {
    const tampered = await signThenTamper({}, (envelope) => {
      envelope.exportedAt = '2020-01-01T00:00:00.000Z';
    });
    expect((await readBackupEnvelope(tampered)).status).toBe('integrity_failed');
  });

  it('rejects a digest that was simply replaced with another valid-looking one', async () => {
    const tampered = await signThenTamper({}, (envelope) => {
      envelope.integrity = { algorithm: 'SHA-256', digest: 'b'.repeat(64) };
    });
    expect((await readBackupEnvelope(tampered)).status).toBe('integrity_failed');
  });

  /**
   * Stated as a test because it is a limitation the app's own copy admits to: a checksum
   * is not a signature, and someone who rewrites the payload can rewrite the digest.
   */
  it('accepts a file whose payload and digest were both rewritten, as a checksum must', async () => {
    const forged = await signEnvelope({
      data: { ...EMPTY_BACKUP_DATA, workoutSessions: [makeBackupSession({ name: 'Forged' })] },
    });
    const result = await readBackupEnvelope(forged);
    expect(result.status).toBe('ok');
  });

  it('verifies the digest before it decodes anything', async () => {
    // A payload that is enormous *and* corrupt must be refused on the checksum, so the
    // decoding work is never done on behalf of whoever supplied the file.
    const huge = 'A'.repeat(400_000);
    const tampered = await signThenTamper(
      {
        data: {
          ...EMPTY_BACKUP_DATA,
          workoutSessions: [makeBackupSession({ notes: huge })],
        },
      },
      (envelope) => {
        const data = envelope.data as BackupData;
        data.workoutSessions[0]!.notes = `${huge.slice(1)}B`;
      },
    );
    const result = await readBackupEnvelope(tampered);
    expect(result.status).toBe('integrity_failed');
  });
});

/**
 * Both singletons are part of "every canonical table", and Replace clears both.
 *
 * A file that omits one would otherwise pass every other rule, clear the table, write
 * nothing into it, and let the next initialization recreate a default -- so the user's
 * restored preferences would quietly become somebody else's starting point. Each fixture
 * here is signed *after* the omission, so its digest is genuinely valid and the refusal
 * cannot be the checksum's doing.
 */
describe('a backup missing a canonical singleton', () => {
  async function readWithout(missing: ('settings' | 'schemaMeta')[]): Promise<BackupReadResult> {
    const data: Record<string, unknown> = { ...EMPTY_BACKUP_DATA };
    for (const key of missing) {
      delete data[key];
    }
    return readBackupEnvelope(await signEnvelope({ data: data as unknown as BackupData }));
  }

  it('refuses one with no preferences', async () => {
    const result = await readWithout(['settings']);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.join(' ')).toContain('settings');
    }
  });

  it('refuses one with no schema metadata', async () => {
    const result = await readWithout(['schemaMeta']);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.join(' ')).toContain('schemaMeta');
    }
  });

  it('refuses one missing both', async () => {
    expect((await readWithout(['settings', 'schemaMeta'])).status).toBe('invalid');
  });

  it('accepts one that carries both, so the rule is about absence and nothing else', async () => {
    expect((await readBackupEnvelope(await signEnvelope())).status).toBe('ok');
  });
});

describe('bounds on a hostile file', () => {
  it('refuses more records in one table than this app will ever restore', async () => {
    const sessions = Array.from({ length: MAX_RECORDS.workoutSessions + 1 }, (_unused, index) =>
      makeBackupSession({ id: testUuid(100_000 + index) }),
    );
    const result = await readBackupEnvelope(
      await signEnvelope({ data: { ...EMPTY_BACKUP_DATA, workoutSessions: sessions } }),
    );
    expect(result.status).toBe('invalid');
  });
});

/**
 * The backup envelope validates strength sets with the same schema an in-app write uses,
 * so version 4's planned/actual split reaches the portable format for free. "For free" is
 * a claim, so it is proved here rather than assumed: an untouched copied set must survive
 * a round trip as a proposal, and must not come back as work somebody recorded.
 */
describe('a strength set crossing the backup boundary', () => {
  const ACTIVITY_ID = testUuid(21);
  const SET_ID = testUuid(41);

  function proposedSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: SET_ID,
      sessionActivityId: ACTIVITY_ID,
      position: 1,
      status: 'planned',
      setType: 'working',
      side: 'both',
      loadBasis: 'per_side',
      plannedReps: 10,
      plannedLoadValue: 60,
      plannedLoadUnit: 'kg',
      plannedLoadGrams: 60_000,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  async function readWithSet(set: Record<string, unknown>): Promise<BackupReadResult> {
    return readBackupEnvelope(
      await signEnvelope({
        data: { ...EMPTY_BACKUP_DATA, strengthSets: [set as never] },
      }),
    );
  }

  it('keeps a proposal a proposal', async () => {
    const result = await readWithSet(proposedSet());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    const restored = result.envelope.data.strengthSets[0];
    expect(restored?.plannedReps).toBe(10);
    expect(restored?.reps).toBeUndefined();
    expect(restored?.loadValue).toBeUndefined();
  });

  it('refuses proposed grams that do not follow from the value and unit beside them', async () => {
    expect((await readWithSet(proposedSet({ plannedLoadGrams: 1 }))).status).toBe('invalid');
  });

  it('refuses a proposed weight with no unit', async () => {
    const result = await readWithSet(
      proposedSet({ plannedLoadUnit: undefined, plannedLoadGrams: undefined }),
    );
    expect(result.status).toBe('invalid');
  });
});
