import {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
} from './numbers.ts';

export const SECONDS_PER_HOUR = 3600;
export const METERS_PER_KILOMETER = 1000;

export function metersToKilometers(meters: number): number {
  return assertNonNegativeFinite(meters, 'meters') / METERS_PER_KILOMETER;
}

export function kilometersToMeters(kilometers: number): number {
  return assertNonNegativeFinite(kilometers, 'kilometers') * METERS_PER_KILOMETER;
}

/**
 * Suggested target duration for a planned distance at a planned displayed speed.
 *
 * This is an estimate only. It assumes one constant speed and ignores acceleration,
 * pauses, and speed changes, so it must never be presented as evidence of what the
 * treadmill actually did. Both inputs must be greater than zero.
 */
export function deriveTargetDurationSeconds(distanceMeters: number, speedKph: number): number {
  const distance = assertPositiveFinite(distanceMeters, 'distanceMeters');
  const speed = assertPositiveFinite(speedKph, 'speedKph');
  return Math.round((distance / METERS_PER_KILOMETER / speed) * SECONDS_PER_HOUR);
}

/** Average speed implied by a *recorded* distance and duration. */
export function deriveAverageSpeedKph(distanceMeters: number, durationSeconds: number): number {
  const distance = assertNonNegativeFinite(distanceMeters, 'distanceMeters');
  const duration = assertPositiveFinite(durationSeconds, 'durationSeconds');
  return distance / METERS_PER_KILOMETER / (duration / SECONDS_PER_HOUR);
}

export interface CardioDurationInputs {
  /** Recorded treadmill time, when the user entered one. */
  actualDurationSeconds?: number | undefined;
  plannedDistanceMeters?: number | undefined;
  plannedSpeedKph?: number | undefined;
  plannedDurationSeconds?: number | undefined;
}

export type CardioDurationSource = 'actual' | 'planned' | 'derived_target' | 'none';

export interface ResolvedCardioDuration {
  seconds: number | undefined;
  source: CardioDurationSource;
  /** `true` when the number is a calculated target rather than a recorded fact. */
  isEstimate: boolean;
}

/**
 * A recorded actual duration always wins over any planned or derived value.
 * A derived target is only produced when no recorded or explicitly planned duration exists.
 */
export function resolveCardioDuration(inputs: CardioDurationInputs): ResolvedCardioDuration {
  const { actualDurationSeconds, plannedDurationSeconds, plannedDistanceMeters, plannedSpeedKph } =
    inputs;

  if (actualDurationSeconds !== undefined) {
    return {
      seconds: assertNonNegativeInteger(actualDurationSeconds, 'actualDurationSeconds'),
      source: 'actual',
      isEstimate: false,
    };
  }
  if (plannedDurationSeconds !== undefined) {
    return {
      seconds: assertNonNegativeInteger(plannedDurationSeconds, 'plannedDurationSeconds'),
      source: 'planned',
      isEstimate: true,
    };
  }
  if (plannedDistanceMeters !== undefined && plannedSpeedKph !== undefined) {
    return {
      seconds: deriveTargetDurationSeconds(plannedDistanceMeters, plannedSpeedKph),
      source: 'derived_target',
      isEstimate: true,
    };
  }
  return { seconds: undefined, source: 'none', isEstimate: false };
}

export function sumSeconds(values: readonly number[]): number {
  return values.reduce<number>(
    (total, value) => total + assertNonNegativeInteger(value, 'durationSeconds'),
    0,
  );
}

export function sumMeters(values: readonly number[]): number {
  return values.reduce<number>(
    (total, value) => total + assertNonNegativeFinite(value, 'distanceMeters'),
    0,
  );
}
