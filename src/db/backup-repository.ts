import { APP_VERSION } from '../config.ts';
import {
  type BackupData,
  type BackupEnvelope,
  type BackupMediaAsset,
  backupStillCovers,
  checkSchemaSupport,
  conflictsForAddAsCopy,
  createBackupEnvelope,
  describeBackup,
  type GraphIssue,
  type ImportConflict,
  type PortableMediaValidator,
  remapForCopy,
  restoreMediaAsset,
  toBackupMediaAsset,
  validateBackupGraph,
  validateSchemaAgreement,
} from '../domain/backup/index.ts';
import { type Clock, systemClock } from '../domain/clock.ts';
import { type IdProvider, systemIdProvider } from '../domain/ids.ts';
import {
  type CardioSegment,
  cardioSegmentSchema,
  type Exercise,
  exerciseSchema,
  type Machine,
  type MachineExerciseConfig,
  machineExerciseConfigSchema,
  machineSchema,
  type MediaAsset,
  mediaAssetSchema,
  type SchemaMeta,
  schemaMetaSchema,
  type SessionActivity,
  sessionActivitySchema,
  type Settings,
  settingsSchema,
  SINGLETON_ID,
  type StrengthSet,
  strengthSetSchema,
  type WorkoutSession,
  workoutSessionSchema,
  type WorkoutTemplate,
  workoutTemplateSchema,
} from '../domain/schemas.ts';
import { ALL_TABLE_NAMES, type GymTrackerDatabase } from './database.ts';
import { CURRENT_SCHEMA_VERSION } from './migrations.ts';
import { parseOrThrow } from './record-validation.ts';

/**
 * Exporting the whole database, and putting a whole database back.
 *
 * The two halves obey the same rule from opposite directions. **Export** reads every
 * table inside one transaction so the file is a single instant rather than a montage,
 * validates every record before writing anything to disk, and refuses rather than
 * producing a backup the app could not read back -- a file the user believes is a copy
 * and is not, is worse than no file.
 *
 * **Import** never touches a row until the entire candidate has passed structural
 * validation, digest verification, real-byte media validation, and the relationship
 * rules. Then it applies the whole thing in one transaction and reads it back *inside*
 * that transaction, so a replacement that is not well formed rolls back rather than
 * committing over months of logging.
 *
 * Preparation and application are separate functions on purpose. Everything expensive and
 * everything that can refuse happens in `prepareImport`, which writes nothing; `applyImport`
 * is the short, all-or-nothing part. That is what lets Settings show a preview, a conflict,
 * or a validation failure without ever having risked the database.
 */

/* -------------------------------------------------------------------------- */
/* Reading the database                                                        */
/* -------------------------------------------------------------------------- */

/** Every canonical table, as it is stored: photos are Blobs here, never base64. */
export interface StoredSnapshot {
  machines: Machine[];
  exercises: Exercise[];
  machineExerciseConfigs: MachineExerciseConfig[];
  workoutTemplates: WorkoutTemplate[];
  workoutSessions: WorkoutSession[];
  sessionActivities: SessionActivity[];
  cardioSegments: CardioSegment[];
  strengthSets: StrengthSet[];
  mediaAssets: MediaAsset[];
  settings: Settings | undefined;
  schemaMeta: SchemaMeta | undefined;
}

export class BackupExportError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`This database cannot be exported safely: ${issues.join('; ')}`);
    this.name = 'BackupExportError';
    this.issues = issues;
  }
}

/**
 * Reads every canonical table in one transaction.
 *
 * One transaction is the whole point: reading the tables one after another would let a
 * write land between two of them and produce a file holding an activity whose session is
 * missing -- a backup that is internally inconsistent through no fault of the user.
 */
export async function readDatabaseSnapshot(db: GymTrackerDatabase): Promise<StoredSnapshot> {
  return db.transaction('r', [...ALL_TABLE_NAMES], async () => ({
    machines: await db.machines.toArray(),
    exercises: await db.exercises.toArray(),
    machineExerciseConfigs: await db.machineExerciseConfigs.toArray(),
    workoutTemplates: await db.workoutTemplates.toArray(),
    workoutSessions: await db.workoutSessions.toArray(),
    sessionActivities: await db.sessionActivities.toArray(),
    cardioSegments: await db.cardioSegments.toArray(),
    strengthSets: await db.strengthSets.toArray(),
    mediaAssets: await db.mediaAssets.toArray(),
    settings: await db.settings.get(SINGLETON_ID),
    schemaMeta: await db.schemaMeta.get(SINGLETON_ID),
  }));
}

/**
 * Checks a snapshot against the same schemas an in-app write uses.
 *
 * Used before an export, so a corrupt row fails visibly instead of being written into a
 * file, and again after a restore, inside the transaction, so a replacement that would not
 * survive a reload never commits.
 */
export function collectSnapshotIssues(snapshot: StoredSnapshot): string[] {
  const issues: string[] = [];
  const check = (
    label: string,
    rows: readonly unknown[],
    schema: { safeParse: (value: unknown) => { success: boolean } },
  ): void => {
    rows.forEach((row, index) => {
      if (!schema.safeParse(row).success) {
        issues.push(`${label}[${String(index)}]`);
      }
    });
  };

  check('machines', snapshot.machines, machineSchema);
  check('exercises', snapshot.exercises, exerciseSchema);
  check('machineExerciseConfigs', snapshot.machineExerciseConfigs, machineExerciseConfigSchema);
  check('workoutTemplates', snapshot.workoutTemplates, workoutTemplateSchema);
  check('workoutSessions', snapshot.workoutSessions, workoutSessionSchema);
  check('sessionActivities', snapshot.sessionActivities, sessionActivitySchema);
  check('cardioSegments', snapshot.cardioSegments, cardioSegmentSchema);
  check('strengthSets', snapshot.strengthSets, strengthSetSchema);
  check('mediaAssets', snapshot.mediaAssets, mediaAssetSchema);

  /*
   * Both singletons must exist, not merely be well formed if present.
   *
   * A backup is a promise about every canonical table, and two of them hold one row each.
   * Exporting without them would produce a file that Replace could apply by clearing both
   * tables and writing neither -- after which initialization would recreate defaults, and
   * the preferences the user believed they had restored would silently be somebody's idea
   * of a sensible starting point. So a database missing either fails its export here,
   * visibly, and the same check refuses the read-back of a restore that lost one.
   */
  if (!snapshot.settings) {
    issues.push('settings: missing');
  } else if (!settingsSchema.safeParse(snapshot.settings).success) {
    issues.push('settings');
  }
  if (!snapshot.schemaMeta) {
    issues.push('schemaMeta: missing');
  } else if (!schemaMetaSchema.safeParse(snapshot.schemaMeta).success) {
    issues.push('schemaMeta');
  }

  /*
   * The relationship rules read fields -- `imageAssetIds`, `sessionId`, `position` -- that
   * only a record which already passed its schema is guaranteed to have. Running them over
   * a malformed row would raise a `TypeError` instead of reporting the malformed row, so a
   * corrupt database would fail with a stack trace rather than with an explanation.
   */
  if (issues.length > 0) {
    return issues;
  }

  for (const issue of validateBackupGraph(snapshot)) {
    issues.push(`${issue.code}: ${issue.detail}`);
  }
  return issues;
}

/** States which earlier check makes a value present, instead of a bare non-null claim. */
function assertPresent<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new BackupExportError([`${label}: missing`]);
  }
  return value;
}

export interface ExportOptions {
  clock?: Clock;
  appVersion?: string;
}

/**
 * The whole database as a portable envelope.
 *
 * Every table is included, and every record in it: active, completed, cancelled,
 * archived, soft-deleted, custom, seeded, and snapshot-only alike. "Export all data" is
 * a promise, so a filter here would be a lie -- a deleted workout the user could still
 * undo yesterday must still be undoable after a restore.
 *
 * The Blob-to-base64 conversion happens *after* the read transaction closes. Awaiting a
 * non-Dexie promise inside a Dexie transaction lets it commit early, and the snapshot has
 * already given us a consistent set of rows to convert.
 */
export async function exportBackup(
  db: GymTrackerDatabase,
  options: ExportOptions = {},
): Promise<BackupEnvelope> {
  const { clock = systemClock, appVersion = APP_VERSION } = options;

  const snapshot = await readDatabaseSnapshot(db);
  const issues = collectSnapshotIssues(snapshot);
  if (issues.length > 0) {
    throw new BackupExportError(issues);
  }

  const mediaAssets: BackupMediaAsset[] = [];
  for (const asset of snapshot.mediaAssets) {
    mediaAssets.push(await toBackupMediaAsset(asset));
  }

  /*
   * `collectSnapshotIssues` has already refused a snapshot missing either singleton, so
   * these two reads cannot be undefined here. The assertions state which check makes that
   * true rather than leaving the reader to find it.
   */
  const data: BackupData = {
    machines: snapshot.machines,
    exercises: snapshot.exercises,
    machineExerciseConfigs: snapshot.machineExerciseConfigs,
    workoutTemplates: snapshot.workoutTemplates,
    workoutSessions: snapshot.workoutSessions,
    sessionActivities: snapshot.sessionActivities,
    cardioSegments: snapshot.cardioSegments,
    strengthSets: snapshot.strengthSets,
    mediaAssets,
    settings: assertPresent(snapshot.settings, 'settings'),
    schemaMeta: assertPresent(snapshot.schemaMeta, 'schemaMeta'),
  };

  return createBackupEnvelope(data, {
    exportedAt: clock.nowIso(),
    appVersion,
    appSchemaVersion: CURRENT_SCHEMA_VERSION,
  });
}

/** The text written to the file. Pretty-printing is not worth doubling a phone's memory. */
export function serializeBackup(envelope: BackupEnvelope): string {
  return JSON.stringify(envelope);
}

/* -------------------------------------------------------------------------- */
/* Preparing an import                                                         */
/* -------------------------------------------------------------------------- */

export type ImportMode = 'add_copy' | 'replace';

export interface ImportPlan {
  mode: ImportMode;
  /** Ready to write, with photos as Blobs and every reference already resolved. */
  records: StoredSnapshot;
  /** Catalog links that resolved to nothing and were degraded to snapshot-only. */
  droppedReferences: number;
  /** True when the file itself holds an open workout. */
  bringsSessionInProgress: boolean;
}

export type PreparedImport =
  | { status: 'ok'; plan: ImportPlan }
  /**
   * The records were written against a database schema this build cannot restore.
   *
   * Its own outcome, not a validation failure: every record in the file may be perfectly
   * well formed for the version that wrote it. The file format version and the database
   * schema version are two different compatibility boundaries, and this is the second one.
   */
  | {
      status: 'unsupported_schema';
      appSchemaVersion: number;
      supportedVersions: readonly number[];
    }
  | { status: 'invalid_graph'; issues: readonly GraphIssue[] }
  /** A photo's bytes are not the image its record claims. Labels only, never contents. */
  | { status: 'invalid_media'; issues: readonly string[] }
  | { status: 'conflict'; conflicts: readonly ImportConflict[] };

/**
 * The database schema versions this build can restore records from.
 *
 * Exactly the current one, because there is no portable migration: nothing in this app
 * rewrites a v3 backup's rows into v4 shapes, and pretending otherwise would write records
 * the rest of the code would then read as though they were current. Adding a version to
 * this list is therefore not a configuration change -- it means writing that migration and
 * the fixture test that verifies it.
 */
export const SUPPORTED_BACKUP_APP_SCHEMA_VERSIONS: readonly number[] = [CURRENT_SCHEMA_VERSION];

export interface PrepareImportOptions {
  mode: ImportMode;
  /**
   * Required, never defaulted.
   *
   * Proving that imported bytes really are the image they claim needs a decoder, and a
   * caller that forgot to supply one would otherwise silently get no check at all. The
   * application passes `browserPhotoValidator`; tests pass a stub decoder.
   */
  validator: PortableMediaValidator;
  ids?: IdProvider;
}

async function restoreMedia(
  assets: readonly BackupMediaAsset[],
  validator: PortableMediaValidator,
): Promise<{ status: 'ok'; assets: MediaAsset[] } | { status: 'invalid'; issues: string[] }> {
  const restored: MediaAsset[] = [];
  const issues: string[] = [];

  for (const dto of assets) {
    const result = restoreMediaAsset(dto);
    if (result.status !== 'ok') {
      issues.push(`${dto.id}: ${result.issues.join(', ')}`);
      continue;
    }
    if (result.asset.storageKind === 'indexeddb_blob') {
      const validation = await validator.validate(result.asset);
      if (validation.status !== 'ok') {
        issues.push(`${dto.id}: ${validation.issues.join(', ')}`);
        continue;
      }
    }
    restored.push(result.asset);
  }

  return issues.length > 0 ? { status: 'invalid', issues } : { status: 'ok', assets: restored };
}

/**
 * Everything that can refuse an import, done before anything can be written.
 *
 * The order matters and is the same as the reader's: cheap structural rules first,
 * decoding last, so a file that will be refused anyway never costs a megabyte of image
 * decoding. Nothing in here touches the database except to read it.
 */
export async function prepareImport(
  db: GymTrackerDatabase,
  envelope: BackupEnvelope,
  options: PrepareImportOptions,
): Promise<PreparedImport> {
  const { mode, validator, ids = systemIdProvider } = options;

  /*
   * First, and before anything is decoded: can this build read records of that shape at
   * all? The reader has already refused an unknown *file format*; this is the other
   * version, the one the rows themselves were written against.
   */
  const support = checkSchemaSupport(
    envelope.appSchemaVersion,
    SUPPORTED_BACKUP_APP_SCHEMA_VERSIONS,
  );
  if (support.status !== 'supported') {
    return {
      status: 'unsupported_schema',
      appSchemaVersion: support.appSchemaVersion,
      supportedVersions: support.supportedVersions,
    };
  }

  const graphIssues = [
    ...validateBackupGraph(envelope.data),
    ...validateSchemaAgreement(envelope.data, envelope.appSchemaVersion),
  ];
  if (graphIssues.length > 0) {
    return { status: 'invalid_graph', issues: graphIssues };
  }

  const preview = describeBackup(envelope);

  if (mode === 'add_copy') {
    const openLocally = await db.workoutSessions.where('status').equals('in_progress').count();
    const conflicts = conflictsForAddAsCopy({
      fileHasSessionInProgress: preview.hasSessionInProgress,
      databaseHasSessionInProgress: openLocally > 0,
    });
    if (conflicts.length > 0) {
      return { status: 'conflict', conflicts };
    }
  }

  const source =
    mode === 'add_copy'
      ? remapForCopy(envelope.data, ids)
      : { data: envelope.data, droppedReferences: 0 };

  const media = await restoreMedia(source.data.mediaAssets, validator);
  if (media.status !== 'ok') {
    return { status: 'invalid_media', issues: media.issues };
  }

  const records: StoredSnapshot = {
    machines: [...source.data.machines],
    exercises: [...source.data.exercises],
    machineExerciseConfigs: [...source.data.machineExerciseConfigs],
    workoutTemplates: [...source.data.workoutTemplates],
    workoutSessions: [...source.data.workoutSessions],
    sessionActivities: [...source.data.sessionActivities],
    cardioSegments: [...source.data.cardioSegments],
    strengthSets: [...source.data.strengthSets],
    mediaAssets: media.assets,
    /*
     * Add-as-copy adopts history, never this installation's preferences or bookkeeping.
     * The file was required to carry both singletons -- that is what stops a partial
     * backup from clearing them and writing nothing -- and this is where a copy declines
     * to *use* the values. Read from the envelope rather than from `source`, whose
     * Add-as-copy form is typed to have neither.
     */
    settings: mode === 'replace' ? envelope.data.settings : undefined,
    schemaMeta: mode === 'replace' ? envelope.data.schemaMeta : undefined,
  };

  return {
    status: 'ok',
    plan: {
      mode,
      records,
      droppedReferences: source.droppedReferences,
      bringsSessionInProgress: preview.hasSessionInProgress,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Applying an import                                                          */
/* -------------------------------------------------------------------------- */

export class ImportFailedError extends Error {
  readonly issues: readonly string[];

  constructor(reason: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${reason}: ${issues.join('; ')}` : reason);
    this.name = 'ImportFailedError';
    this.issues = issues;
  }
}

/**
 * The safety backup no longer describes the database it was taken from.
 *
 * Its own error type because it is the one import failure that is not about the file being
 * imported, and because the only useful recovery is a different one: take a fresh backup.
 * Nothing was cleared -- the comparison happens before the first `clear()`, in the same
 * transaction, so there is no window in which another tab could change the answer.
 */
export class StaleSafetyBackupError extends ImportFailedError {
  constructor() {
    super('The safety backup no longer describes this database, so nothing was replaced');
    this.name = 'StaleSafetyBackupError';
  }
}

/**
 * Where an import has got to.
 *
 * Reported so a long restore is not a frozen screen, and used by the failure-injection
 * tests to throw at each stage and prove the whole thing rolls back.
 */
export type ImportStep = 'clearing' | 'catalog' | 'workouts' | 'media' | 'settings' | 'verifying';

export const IMPORT_STEPS: readonly ImportStep[] = [
  'clearing',
  'catalog',
  'workouts',
  'media',
  'settings',
  'verifying',
];

export interface ApplyImportOptions {
  /**
   * A notification, never part of the transaction's work.
   *
   * This is deliberately synchronous. In particular, Replace must not await arbitrary
   * application code after it proves the safety backup is current and before it clears
   * the first table: IndexedDB could otherwise auto-commit during that await and reopen
   * the check-then-act window this contract exists to close.
   */
  onProgress?: (step: ImportStep) => void;
  /**
   * Replace only, and required there.
   *
   * The type makes a backup impossible to skip; it cannot, on its own, make the backup
   * *cover* what is about to be destroyed -- any envelope satisfies a type. So the
   * envelope is also compared, field by field, with the database as it stands at the
   * start of the clearing transaction, and a Replace whose safety copy has fallen behind
   * is refused rather than performed. Offering the download is the interface's job;
   * proving it still applies is this one's.
   */
  safetyBackup?: BackupEnvelope;
}

export interface ImportOutcome {
  mode: ImportMode;
  written: number;
  droppedReferences: number;
}

function countRecords(records: StoredSnapshot): number {
  return (
    records.machines.length +
    records.exercises.length +
    records.machineExerciseConfigs.length +
    records.workoutTemplates.length +
    records.workoutSessions.length +
    records.sessionActivities.length +
    records.cardioSegments.length +
    records.strengthSets.length +
    records.mediaAssets.length
  );
}

/**
 * Writes the prepared plan, all of it or none of it.
 *
 * Everything happens inside one Dexie transaction across every table, including the
 * read-back. A throw anywhere -- a constraint violation, an injected failure, a read-back
 * that does not validate -- aborts the transaction, and the database is left exactly as it
 * was. That is why the verification is *inside*: a check after the commit could only
 * report the damage, not prevent it.
 */
export async function applyImport(
  db: GymTrackerDatabase,
  plan: ImportPlan,
  options: ApplyImportOptions = {},
): Promise<ImportOutcome> {
  const { onProgress, safetyBackup } = options;

  if (plan.mode === 'replace' && !safetyBackup) {
    throw new ImportFailedError('Replace requires a safety backup of the current database');
  }

  const report = (step: ImportStep): void => {
    onProgress?.(step);
  };

  await db.transaction('rw', [...ALL_TABLE_NAMES], async () => {
    if (plan.mode === 'replace') {
      /*
       * The safety backup has to still be a backup *of this database*.
       *
       * Between saving it and confirming the replacement, a preference can change on this
       * very page, a set can be finished in another tab, or a machine can be added. All of
       * that would be destroyed by a Replace authorized by the earlier file, and none of
       * it would be in the copy the user was told to keep.
       *
       * The read and the comparison sit at the top of the transaction that does the
       * clearing, before the first `clear()` and with no non-Dexie await between them, so
       * there is no check-then-act window: any writer that lands afterwards is serialized
       * behind this transaction, and any that landed before it is visible to this read.
       */
      const current = await readSnapshotWithin(db);
      if (!safetyBackup || !backupStillCovers(current, safetyBackup.data)) {
        throw new StaleSafetyBackupError();
      }

      report('clearing');
      for (const table of ALL_TABLE_NAMES) {
        await db.table(table).clear();
      }
    } else {
      /*
       * The one-workout invariant, decided inside the transaction that would break it.
       * The preview asked the same question earlier so the interface could explain the
       * conflict; this is what makes the answer true, because a workout can be started in
       * another tab between the two.
       */
      const openLocally = await db.workoutSessions.where('status').equals('in_progress').count();
      if (openLocally > 0 && plan.bringsSessionInProgress) {
        throw new ImportFailedError('Importing would leave two workouts in progress');
      }
    }

    const write = plan.mode === 'replace' ? 'put' : 'add';

    report('catalog');
    await bulkWrite(db.machines, plan.records.machines, write);
    await bulkWrite(db.exercises, plan.records.exercises, write);
    await bulkWrite(db.machineExerciseConfigs, plan.records.machineExerciseConfigs, write);
    await bulkWrite(db.workoutTemplates, plan.records.workoutTemplates, write);

    report('workouts');
    await bulkWrite(db.workoutSessions, plan.records.workoutSessions, write);
    await bulkWrite(db.sessionActivities, plan.records.sessionActivities, write);
    await bulkWrite(db.cardioSegments, plan.records.cardioSegments, write);
    await bulkWrite(db.strengthSets, plan.records.strengthSets, write);

    report('media');
    await bulkWrite(db.mediaAssets, plan.records.mediaAssets, write);

    report('settings');
    if (plan.mode === 'replace') {
      if (plan.records.settings) {
        await db.settings.put(parseOrThrow(settingsSchema, plan.records.settings, 'settings'));
      }
      if (plan.records.schemaMeta) {
        await db.schemaMeta.put(
          parseOrThrow(schemaMetaSchema, plan.records.schemaMeta, 'schemaMeta'),
        );
      }
    }

    report('verifying');
    const readBack = await readSnapshotWithin(db);
    const issues = collectSnapshotIssues(readBack);
    if (issues.length > 0) {
      throw new ImportFailedError('The imported records did not verify', issues);
    }
    const open = readBack.workoutSessions.filter((session) => session.status === 'in_progress');
    if (open.length > 1) {
      throw new ImportFailedError('Importing would leave two workouts in progress');
    }
  });

  return {
    mode: plan.mode,
    written: countRecords(plan.records),
    droppedReferences: plan.droppedReferences,
  };
}

/** The same reads as `readDatabaseSnapshot`, for use inside an open transaction. */
async function readSnapshotWithin(db: GymTrackerDatabase): Promise<StoredSnapshot> {
  return {
    machines: await db.machines.toArray(),
    exercises: await db.exercises.toArray(),
    machineExerciseConfigs: await db.machineExerciseConfigs.toArray(),
    workoutTemplates: await db.workoutTemplates.toArray(),
    workoutSessions: await db.workoutSessions.toArray(),
    sessionActivities: await db.sessionActivities.toArray(),
    cardioSegments: await db.cardioSegments.toArray(),
    strengthSets: await db.strengthSets.toArray(),
    mediaAssets: await db.mediaAssets.toArray(),
    settings: await db.settings.get(SINGLETON_ID),
    schemaMeta: await db.schemaMeta.get(SINGLETON_ID),
  };
}

interface BulkTable<T> {
  bulkAdd: (rows: readonly T[]) => Promise<unknown>;
  bulkPut: (rows: readonly T[]) => Promise<unknown>;
}

/**
 * `add` for a copy, `put` for a replace, and the difference is the safety rule.
 *
 * Add-as-copy must never overwrite: `bulkAdd` raises a constraint error if any id already
 * exists, which aborts the transaction. Every id was freshly minted, so this should never
 * fire -- which is exactly why it is worth having, because "should never" is the class of
 * assumption that silently destroys a record when it turns out to be wrong.
 */
async function bulkWrite<T>(
  table: BulkTable<T>,
  rows: readonly T[],
  mode: 'add' | 'put',
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  if (mode === 'add') {
    await table.bulkAdd(rows);
    return;
  }
  await table.bulkPut(rows);
}
