import type Dexie from 'dexie';
import type { Transaction } from 'dexie';

/**
 * One entry per released schema version.
 *
 * Migrations are forward-only and additive: an entry that has shipped is never edited,
 * because a device that already upgraded will not replay it. A change to stored data
 * always arrives as a *new* entry with its own upgrade function and fixture test.
 */
export interface SchemaVersionDefinition {
  version: number;
  /** Dexie store definition. The first listed key is the primary key. */
  stores: Record<string, string | null>;
  upgrade?: (transaction: Transaction) => Promise<void> | void;
}

/**
 * Index policy: index only the lookups the plan actually needs.
 *
 * - Optional fields are stored as `undefined` when absent, never `null`, because
 *   IndexedDB cannot use `null` as a key. A row with an absent value simply does not
 *   appear in that index, so `archivedAt` and `deletedAt` are deliberately *not*
 *   indexed: "everything not archived" is not answerable from such an index.
 * - `seedKey` is a *unique* index (`&`) on every seeded table, because the seed harness
 *   and lookups treat one key as one record. Records without a seed key store
 *   `undefined`, which IndexedDB leaves out of the index entirely, so any number of
 *   user-created records coexist happily.
 * - Child records are indexed by `[parent+position]` because they are always read as
 *   an ordered list belonging to one parent.
 */
export const SCHEMA_VERSIONS: readonly SchemaVersionDefinition[] = [
  {
    version: 1,
    stores: {
      machines: 'id, &seedKey, name, loadingKind, category',
      exercises: 'id, &seedKey, name, trackingKind, *machineIds',
      machineExerciseConfigs: 'id, machineId, exerciseId, [machineId+exerciseId]',
      workoutTemplates: 'id, &seedKey, name',
      workoutSessions: 'id, status, startedAt, [status+startedAt]',
      sessionActivities: 'id, sessionId, [sessionId+position]',
      cardioSegments: 'id, sessionActivityId, [sessionActivityId+position]',
      strengthSets: 'id, sessionActivityId, [sessionActivityId+position]',
      mediaAssets: 'id, kind',
      settings: 'id',
      schemaMeta: 'id',
    },
  },
  {
    /**
     * Schema v2 gives seeded media assets and seeded machine-exercise configurations
     * the same stable identity the other seeded tables already had.
     *
     * Only the two changed stores are listed: Dexie carries every unlisted table forward
     * from the previous version unchanged. No `upgrade` function is needed because no
     * stored value changes shape -- the new indexes simply describe a field that older
     * records leave `undefined`, and IndexedDB omits those rows from a unique index
     * entirely. The fixture test in `migrations.test.ts` proves a populated version 1
     * database opens at version 2 with every record intact.
     */
    version: 2,
    stores: {
      mediaAssets: 'id, kind, &seedKey',
      machineExerciseConfigs: 'id, machineId, exerciseId, [machineId+exerciseId], &seedKey',
    },
  },
  {
    /**
     * Schema v3 separates a cardio segment's planned incline from its actual incline,
     * gives every segment an explicit lifecycle status, gives every session activity a
     * durable display name, and makes a session's two terminal timestamps mutually
     * exclusive.
     *
     * Unlike version 2 this one *does* change stored shape, so it needs a real upgrade
     * function. No index changes: `workoutSessions.status` already answers "is a session
     * in progress", `[status+startedAt]` already answers "what was completed most
     * recently", and children are still read as an ordered list under one parent. An
     * empty `stores` object leaves every table's indexes exactly as version 2 left them.
     *
     * No device can be holding affected rows today, because the earlier app could not create a session, a segment, or a template. The transform is written and
     * fixture-tested anyway: a migration that has shipped can never be edited afterwards,
     * so the moment to get it right is now, and "there is no data" is an assumption about
     * the field rather than a fact this code can check.
     */
    version: 3,
    stores: {},
    async upgrade(transaction) {
      await transaction
        .table<MutableRecord>('workoutSessions')
        .toCollection()
        .modify(migrateTerminalTimestamps);

      await transaction
        .table<MutableRecord>('cardioSegments')
        .toCollection()
        .modify(migrateInclinePair);

      await transaction
        .table<MutableRecord>('sessionActivities')
        .toCollection()
        .modify((activity) => {
          if (typeof activity.displayName !== 'string') {
            activity.displayName = deriveActivityDisplayName(activity);
          }
        });

      await transaction
        .table<MutableRecord>('workoutTemplates')
        .toCollection()
        .modify((template) => {
          const items = template.activityTemplates;
          if (!Array.isArray(items)) {
            return;
          }
          for (const item of items as MutableRecord[]) {
            const targets = item.cardioTargets;
            if (Array.isArray(targets)) {
              for (const target of targets as MutableRecord[]) {
                renameInclineFields(target);
              }
            }
          }
        });
    },
  },
  {
    /**
     * Schema v4 separates a strength set's *proposed* values from the ones the
     * user actually recorded.
     *
     * Before this version, "Copy last set" wrote the source set's reps, time, and load
     * straight into the new row's `reps`, `durationSeconds`, and load trio -- the fields
     * that mean "the user recorded this". A single tap therefore created a row the app
     * treated as performed work: it refused to remove or skip it, and printed its numbers
     * in the finish summary as values the user had entered. The proposal now lives in
     * `plannedReps`, `plannedDurationSeconds`, and a `plannedLoad*` trio of its own.
     *
     * No index changes: `[sessionActivityId+position]` still answers the only question
     * anything asks of this table, and none of the new fields is ever looked up by key.
     *
     * The upgrade below is the honest one, and its limits are worth stating because the
     * alternative is tempting. A row written by the defective build holds its copied
     * numbers in the recorded fields, and **nothing in the record distinguishes them from
     * numbers the user entered**. Moving them to the planned fields would silently
     * erase real entries; leaving them alone keeps a small number of rows that overstate
     * what was recorded. Between destroying a genuine record and preserving a suspect one,
     * this preserves. What it does do is enforce the new invariant on every existing row:
     * a completed set never carries a pending proposal, and a partial load trio -- grams
     * without the value and unit they came from -- is dropped rather than left to fail
     * validation on the next read.
     */
    version: 4,
    stores: {},
    async upgrade(transaction) {
      await transaction.table<MutableRecord>('strengthSets').toCollection().modify(migrateSetPlan);
    },
  },
];

/** A stored row being rewritten in place by an upgrade. */
type MutableRecord = Record<string, unknown>;

/**
 * `inclineValue`/`inclineType` described a single incline, which meant recording what the
 * treadmill actually showed would overwrite the target that had been set. The pair is
 * renamed to the planned one; the actual pair starts out honestly unknown.
 */
function renameInclineFields(record: MutableRecord): void {
  const value = record.inclineValue;
  const type = record.inclineType;
  delete record.inclineValue;
  delete record.inclineType;

  if (value !== undefined && record.plannedInclineValue === undefined) {
    record.plannedInclineValue = value;
  }
  if (record.plannedInclineType === undefined) {
    record.plannedInclineType = typeof type === 'string' ? type : 'unknown';
  }
}

/**
 * Version 2 let a cancelled session record its ending in `completedAt` and had no
 * `cancelledAt` at all. Version 3 requires the two to be mutually exclusive, so a row that
 * was perfectly valid under version 2 would be invalid under version 3 unless it is
 * converted here.
 *
 * The conversion is deterministic and prefers the most trustworthy stored instant:
 *
 * 1. `completedAt`, which under version 2 was written at the moment the session ended;
 * 2. `updatedAt`, the last time the row was written, which for a cancelled session is
 *    when it was cancelled;
 * 3. `startedAt`, which is always present and is never later than the ending.
 *
 * Nothing is invented: every candidate is an instant the database already held. The
 * `completedAt` is then removed, because after this version a cancelled session claiming
 * a completion time is a contradiction rather than a record.
 */
function migrateTerminalTimestamps(session: MutableRecord): void {
  if (session.status !== 'cancelled') {
    return;
  }
  if (typeof session.cancelledAt !== 'string') {
    for (const candidate of [session.completedAt, session.updatedAt, session.startedAt]) {
      if (typeof candidate === 'string') {
        session.cancelledAt = candidate;
        break;
      }
    }
  }
  delete session.completedAt;
}

function migrateInclinePair(segment: MutableRecord): void {
  renameInclineFields(segment);
  if (segment.actualInclineType === undefined) {
    segment.actualInclineType = 'unknown';
  }
  if (segment.status === undefined) {
    // An existing segment recorded no completion state, so it cannot be claimed as
    // completed work. `planned` is the only honest reading.
    segment.status = 'planned';
  }
}

/**
 * Brings an existing strength set up to the planned/actual invariants version 4 adds.
 *
 * Two things are made true, and nothing is invented:
 *
 * 1. **A completed set holds no pending proposal.** Completion is the moment the values
 *    stop being a suggestion, so any `planned*` field on a completed row is a leftover
 *    rather than an outstanding question, and a leftover suggestion would reappear in the
 *    fields the moment the set was reopened.
 * 2. **A planned load trio is whole or absent.** Grams with no value and unit beside them
 *    describe a weight nothing can reconstruct, exactly as on the recorded side.
 *
 * The recorded fields are never touched. A row written before this version may hold copied
 * numbers there, and no rule can tell those apart from numbers the user typed.
 */
function migrateSetPlan(set: MutableRecord): void {
  const plannedFields = [
    'plannedReps',
    'plannedDurationSeconds',
    'plannedLoadValue',
    'plannedLoadUnit',
    'plannedLoadGrams',
  ] as const;

  if (set.status === 'completed') {
    for (const field of plannedFields) {
      delete set[field];
    }
    return;
  }

  if (set.plannedLoadValue === undefined || set.plannedLoadUnit === undefined) {
    delete set.plannedLoadValue;
    delete set.plannedLoadUnit;
    delete set.plannedLoadGrams;
  }
}

/**
 * A pre-version-3 activity had no name of its own and borrowed one from its snapshot at
 * render time. The stored record now owns the label, so the same snapshot fields are
 * used once, here, rather than by every component that displays it.
 */
function deriveActivityDisplayName(activity: MutableRecord): string {
  const snapshot = (activity.snapshot ?? {}) as MutableRecord;
  const exerciseName = snapshot.exerciseName;
  const machineName = snapshot.machineName;
  if (typeof exerciseName === 'string' && exerciseName.length > 0) {
    return exerciseName;
  }
  if (typeof machineName === 'string' && machineName.length > 0) {
    return machineName;
  }
  return 'Untitled activity';
}

export const CURRENT_SCHEMA_VERSION: number = SCHEMA_VERSIONS.reduce(
  (highest, definition) => Math.max(highest, definition.version),
  0,
);

/** Guards the invariant the migration harness depends on: versions ascend from 1 by one. */
export function assertSchemaVersionsAreSequential(
  definitions: readonly SchemaVersionDefinition[] = SCHEMA_VERSIONS,
): void {
  if (definitions.length === 0) {
    throw new Error('At least one schema version must be defined');
  }
  definitions.forEach((definition, index) => {
    if (definition.version !== index + 1) {
      throw new Error(
        `Schema versions must be sequential from 1; found ${String(definition.version)} at position ${String(index)}`,
      );
    }
  });
}

export function applySchemaVersions(
  db: Dexie,
  definitions: readonly SchemaVersionDefinition[] = SCHEMA_VERSIONS,
): void {
  assertSchemaVersionsAreSequential(definitions);
  for (const definition of definitions) {
    const version = db.version(definition.version).stores(definition.stores);
    if (definition.upgrade) {
      version.upgrade(definition.upgrade);
    }
  }
}
