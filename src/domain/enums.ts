/**
 * Closed vocabularies shared by the TypeScript types, the Zod boundary schemas,
 * and the centralized UI strings. Adding a member here is a deliberate schema
 * decision, not a UI tweak.
 */

export const LOAD_UNITS = ['kg', 'lb'] as const;
export type LoadUnit = (typeof LOAD_UNITS)[number];

export const DISTANCE_UNITS = ['km', 'mi'] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/**
 * What a recorded load number actually means. Unit alone is never sufficient:
 * `50 kg` on a selectorized stack is not `50 kg` of plates per side.
 */
export const LOAD_BASES = [
  'stack_display',
  'per_side',
  'total_added',
  'each_hand',
  'combined',
  'assisted',
  'bodyweight',
  'unknown',
] as const;
export type LoadBasis = (typeof LOAD_BASES)[number];

export const LOADING_KINDS = [
  'selectorized',
  'plate_loaded',
  'cable',
  'bodyweight',
  'cardio',
  'other',
] as const;
export type LoadingKind = (typeof LOADING_KINDS)[number];

export const MACHINE_CATEGORIES = [
  'cardio',
  'lower_body',
  'upper_body',
  'full_body',
  'other',
] as const;
export type MachineCategory = (typeof MACHINE_CATEGORIES)[number];

/**
 * Muscle-area labels. `back` is the area label; a specific exercise may target
 * lats, rhomboids, trapezius, or spinal erectors, but a partial machine photo is
 * not evidence of exact anatomy.
 */
export const MUSCLE_GROUPS = [
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'core',
  'glutes',
  'hips',
  'quadriceps',
  'hamstrings',
  'calves',
  'full_body',
  'other',
] as const;
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

export const MOVEMENT_PATTERNS = [
  'push',
  'pull',
  'squat',
  'hinge',
  'lunge',
  'carry',
  'isolation',
  'cardio',
  'other',
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

export const TRACKING_KINDS = ['strength', 'cardio', 'duration', 'distance', 'custom'] as const;
export type TrackingKind = (typeof TRACKING_KINDS)[number];

export const IDENTIFICATION_CONFIDENCES = [
  'owner_confirmed',
  'high',
  'medium',
  'low',
  'unverified',
] as const;
export type IdentificationConfidence = (typeof IDENTIFICATION_CONFIDENCES)[number];

export const SESSION_STATUSES = ['in_progress', 'completed', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ACTIVITY_KINDS = ['cardio', 'strength', 'custom'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const CARDIO_MODES = ['run', 'walk', 'warmup', 'cooldown', 'custom'] as const;
export type CardioMode = (typeof CARDIO_MODES)[number];

/**
 * `unknown` is the honest default: a treadmill showing `16` has not told us
 * whether that is a percentage grade or a device-specific level.
 */
export const INCLINE_TYPES = ['percent', 'level', 'unknown'] as const;
export type InclineType = (typeof INCLINE_TYPES)[number];

export const SET_STATUSES = ['planned', 'completed', 'skipped'] as const;
export type SetStatus = (typeof SET_STATUSES)[number];

/**
 * A cardio segment's lifecycle. It deliberately mirrors `SET_STATUSES` in its members
 * but is a separate vocabulary: the two describe different records, and a later change
 * to one must not silently redefine the other.
 *
 * `planned` is a target nobody has performed yet, `completed` records real work on the
 * treadmill, and `skipped` says the segment was deliberately not done. Only `completed`
 * ever contributes to an actual total.
 */
export const SEGMENT_STATUSES = ['planned', 'completed', 'skipped'] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const SET_TYPES = ['warmup', 'working', 'drop', 'failure', 'custom'] as const;
export type SetType = (typeof SET_TYPES)[number];

export const BODY_SIDES = ['both', 'left', 'right'] as const;
export type BodySide = (typeof BODY_SIDES)[number];

export const MEDIA_KINDS = ['machine_photo', 'user_photo'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Which rendering a media asset is for. A machine holds several assets and the list's
 * order must never be the thing that decides which is the small one.
 */
export const MEDIA_ROLES = ['thumbnail', 'detail'] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

export const MEDIA_STORAGE_KINDS = ['static_url', 'indexeddb_blob'] as const;
export type MediaStorageKind = (typeof MEDIA_STORAGE_KINDS)[number];

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;
export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const THEME_PREFERENCES = ['system', 'dark', 'light'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
