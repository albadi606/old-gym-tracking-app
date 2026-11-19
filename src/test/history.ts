import { createFixedClock } from '../domain/clock.ts';
import type { LoadUnit } from '../domain/enums.ts';
import type { SessionAggregate } from '../domain/history/session-view.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import { getExerciseBySeedKey, getMachineBySeedKey } from '../db/catalog-repository.ts';
import type { GymTrackerDatabase } from '../db/database.ts';
import {
  addStrengthActivity,
  addStrengthSet,
  completeStrengthSet,
} from '../db/strength-repository.ts';
import {
  cancelSession,
  completeCardioSegment,
  finishSession,
  getTemplateBySeedKey,
  startBlankSession,
  startSessionFromTemplate,
  updateCardioSegment,
} from '../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../db/workout-seed-data.ts';
import type {
  CardioSegment,
  SessionActivity,
  StrengthSet,
  WorkoutSession,
} from '../domain/schemas.ts';
import { toCanonicalGrams } from '../domain/units.ts';

/**
 * Builders for recorded workouts.
 *
 * Every fixture describes an invented "Test" session so nothing here can be mistaken for
 * real workout history, and every identifier is a literal so a failure names the row it
 * is about. The zone defaults to `Asia/Tbilisi` because the local-day rules are the ones
 * most worth getting wrong quietly.
 */

export const TBILISI = 'Asia/Tbilisi';
const BASE = '00000000-0000-4000-8000-0000000000';

export function uuid(suffix: string): string {
  return `${BASE}${suffix.padStart(2, '0')}`;
}

export function makeSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  const startedAt = overrides.startedAt ?? '2026-09-01T13:00:00.000Z';
  return {
    id: uuid('01'),
    name: 'Test session',
    status: 'completed',
    startedAt,
    completedAt: '2026-09-01T14:00:00.000Z',
    timeZone: TBILISI,
    utcOffsetMinutes: 240,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

export function makeActivity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    id: uuid('11'),
    sessionId: uuid('01'),
    position: 0,
    kind: 'strength',
    displayName: 'Test press',
    snapshot: {},
    createdAt: '2026-09-01T13:00:00.000Z',
    updatedAt: '2026-09-01T13:00:00.000Z',
    ...overrides,
  };
}

export function makeSegment(overrides: Partial<CardioSegment> = {}): CardioSegment {
  return {
    id: uuid('21'),
    sessionActivityId: uuid('11'),
    position: 0,
    mode: 'run',
    status: 'planned',
    plannedInclineType: 'unknown',
    actualInclineType: 'unknown',
    createdAt: '2026-09-01T13:00:00.000Z',
    updatedAt: '2026-09-01T13:00:00.000Z',
    ...overrides,
  };
}

export function makeSet(overrides: Partial<StrengthSet> = {}): StrengthSet {
  return {
    id: uuid('31'),
    sessionActivityId: uuid('11'),
    position: 0,
    status: 'planned',
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    createdAt: '2026-09-01T13:00:00.000Z',
    updatedAt: '2026-09-01T13:00:00.000Z',
    ...overrides,
  };
}

/** A completed set carrying a load, with the canonical grams derived from that exact pair. */
export function makeCompletedSet(overrides: Partial<StrengthSet> = {}): StrengthSet {
  const loadValue = overrides.loadValue;
  const loadUnit = overrides.loadUnit ?? 'kg';
  return makeSet({
    status: 'completed',
    completedAt: '2026-09-01T13:30:00.000Z',
    reps: 10,
    ...(loadValue === undefined
      ? {}
      : { loadValue, loadUnit, loadGrams: toCanonicalGrams(loadValue, loadUnit) }),
    ...overrides,
  });
}

export function makeAggregate(parts: Partial<SessionAggregate> = {}): SessionAggregate {
  const session = parts.session ?? makeSession();
  return {
    session,
    activities: parts.activities ?? [makeActivity({ sessionId: session.id })],
    segments: parts.segments ?? [],
    strengthSets: parts.strengthSets ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Recording a real workout, through the real repositories                     */
/* -------------------------------------------------------------------------- */

export interface SeedWorkoutOptions {
  /**
   * The identity range this workout mints from.
   *
   * The sequential provider is deterministic on purpose, so two workouts in one database
   * need two ranges or the second collides with the first.
   */
  idBase?: number;
  startedAt?: string;
  name?: string;
  distanceMeters?: number;
  durationSeconds?: number;
  /** Records a distance but no time, so nothing can derive a speed from this segment. */
  omitDuration?: boolean;
  reps?: number;
  loadValue?: number;
  loadUnit?: LoadUnit;
  /** A note on the cardio segment, so a test can prove a note survives or is cleared. */
  segmentNotes?: string;
  /** How the workout ends. `open` leaves it in progress. */
  ending?: 'finish' | 'cancel' | 'open';
  /** Adds a strength activity with one completed set. */
  withStrength?: boolean;
  /**
   * `template` starts from the seeded routine, which carries all four machines.
   * `blank` starts an empty session, so a test can build a workout that mentions exactly
   * one machine -- which is the only way to tell the machine filter apart from a filter
   * that matches everything.
   */
  from?: 'template' | 'blank';
  machineSeedKey?: string;
  exerciseSeedKey?: string;
}

/**
 * A workout recorded the way the application records one.
 *
 * It goes through the real repositories rather than writing rows directly, so a test
 * built on it is testing history against data the workout screen could actually have
 * produced -- including every snapshot, position, and timestamp those paths set.
 */
export async function seedRecordedWorkout(
  db: GymTrackerDatabase,
  options: SeedWorkoutOptions = {},
): Promise<{ sessionId: string; activityIds: string[] }> {
  const {
    idBase = 1000,
    startedAt = '2026-09-05T05:00:00.000Z',
    name,
    distanceMeters = 2400,
    durationSeconds = 960,
    omitDuration = false,
    reps = 10,
    loadValue = 40,
    loadUnit = 'kg',
    segmentNotes,
    ending = 'finish',
    withStrength = true,
    from = 'template',
    machineSeedKey = 'seated-leg-press-01',
    exerciseSeedKey = 'seated-leg-press',
  } = options;

  const clock = createFixedClock(startedAt);
  const identity = {
    clock,
    ids: createSequentialIdProvider(idBase),
    timeZone: TBILISI,
    utcOffsetMinutes: 240,
  };

  let detail;
  if (from === 'blank') {
    detail = await startBlankSession(db, { ...identity, name: name ?? 'Test workout' });
  } else {
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    if (!template) {
      throw new Error('expected the starter template to be seeded');
    }
    detail = await startSessionFromTemplate(db, template.id, {
      ...identity,
      ...(name === undefined ? {} : { name }),
    });
  }

  const segment = detail.segments[0];
  if (segment) {
    await updateCardioSegment(db, segment.id, {
      actualDistanceMeters: distanceMeters,
      actualDurationSeconds: omitDuration ? undefined : durationSeconds,
      actualSpeedKph: 9,
      ...(segmentNotes === undefined ? {} : { notes: segmentNotes }),
    });
    await completeCardioSegment(db, segment.id, {}, { clock });
  }

  const activityIds = detail.activities.map((activity) => activity.id);

  if (withStrength) {
    const machine = await getMachineBySeedKey(db, machineSeedKey);
    const exercise = await getExerciseBySeedKey(db, exerciseSeedKey);
    if (!machine || !exercise) {
      throw new Error(`expected the seeded ${machineSeedKey} machine and exercise`);
    }
    const activity = await addStrengthActivity(
      db,
      detail.session.id,
      { machineId: machine.id, exerciseId: exercise.id },
      { clock, ids: createSequentialIdProvider(idBase + 100) },
    );
    activityIds.push(activity.id);
    const set = await addStrengthSet(db, activity.id, {
      clock,
      ids: createSequentialIdProvider(idBase + 200),
    });
    await completeStrengthSet(
      db,
      set.id,
      { reps, loadValue, loadUnit, loadGrams: toCanonicalGrams(loadValue, loadUnit) },
      { clock },
    );
  }

  if (ending === 'finish') {
    await finishSession(db, detail.session.id, { clock });
  } else if (ending === 'cancel') {
    await cancelSession(db, detail.session.id, { clock });
  }

  return { sessionId: detail.session.id, activityIds };
}
