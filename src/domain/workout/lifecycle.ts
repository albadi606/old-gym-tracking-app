import type { SessionStatus } from '../enums.ts';

/**
 * What may happen to a session, and when.
 *
 * These rules are pure so they can be asserted without a database and reused by the
 * repository and the UI. The repository still re-checks them inside
 * the writing transaction: a rule evaluated in a component is advice, and only a check
 * that happens where the write happens is an invariant.
 */

/** Only an in-progress session may be edited, finished, or cancelled. */
export function isMutableSessionStatus(status: SessionStatus): boolean {
  return status === 'in_progress';
}

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export type SessionTransition = 'finish' | 'cancel';

/**
 * How a requested transition should be treated.
 *
 * `already_applied` is what makes finishing and cancelling idempotent. A second tap on
 * Finish, or a retry after a response was lost, must not write a second completion time
 * or invent a second session -- but it is also not an error the user needs to see, since
 * the outcome they asked for is the outcome they have.
 */
export type TransitionOutcome = 'apply' | 'already_applied' | 'refused';

export function planSessionTransition(
  status: SessionStatus,
  transition: SessionTransition,
): TransitionOutcome {
  if (status === 'in_progress') {
    return 'apply';
  }
  if (transition === 'finish' && status === 'completed') {
    return 'already_applied';
  }
  if (transition === 'cancel' && status === 'cancelled') {
    return 'already_applied';
  }
  // Finishing a cancelled session, or cancelling a completed one, would rewrite a
  // decision the user already made. Refuse it and say so.
  return 'refused';
}

export type SessionLifecycleReason =
  /** A second session cannot start while one is in progress. */
  | 'active_session_exists'
  /** The session was completed or cancelled, so its recorded work is closed to edits. */
  | 'session_not_editable'
  /** The requested transition contradicts the status the session already reached. */
  | 'invalid_transition'
  /** The template was archived, so it is no longer a routine the user intends to run. */
  | 'template_not_startable'
  /** Only a completed, undeleted session describes a workout worth repeating. */
  | 'source_not_repeatable'
  /** The session is in the trash. It is restored before anything else may touch it. */
  | 'session_deleted'
  /**
   * The session is still in progress, so History is the wrong place to change it.
   *
   * A live workout is corrected on the workout screen, where the draft-ownership and
   * terminal-claim contracts protect what is on the cards. Editing the same rows from a
   * second screen would step straight around all of it.
   */
  | 'session_in_progress'
  /** The row named by a correction does not belong to the session being corrected. */
  | 'record_not_in_session';

/**
 * Raised instead of silently doing something else.
 *
 * `activeSessionId` is carried when a start was blocked, so the caller can offer to
 * resume the real session rather than leaving the user tapping a button that appears to
 * do nothing.
 */
export class SessionLifecycleError extends Error {
  readonly reason: SessionLifecycleReason;
  readonly activeSessionId: string | undefined;

  constructor(reason: SessionLifecycleReason, message: string, activeSessionId?: string) {
    super(message);
    this.name = 'SessionLifecycleError';
    this.reason = reason;
    this.activeSessionId = activeSessionId;
  }
}

export type SegmentLifecycleReason =
  /** Removing or hiding it would destroy something the user recorded. */
  | 'segment_has_recorded_work'
  /** The segment is not in the state the requested change assumes. */
  | 'segment_not_completed'
  /** A reorder named a set of segments that is not the activity's own set. */
  | 'segment_order_mismatch'
  /** Cardio segments belong to cardio activities; a strength activity owns sets instead. */
  | 'activity_is_not_cardio';

/**
 * Raised when a cardio change would lose recorded work or contradict the stored order.
 *
 * It is separate from `SessionLifecycleError` because the two describe different records
 * and a caller usually reacts to them differently: a closed session is a dead end, while
 * a refused removal is an invitation to reopen the segment instead.
 */
export class CardioSegmentError extends Error {
  readonly reason: SegmentLifecycleReason;
  readonly segmentId: string | undefined;

  constructor(reason: SegmentLifecycleReason, message: string, segmentId?: string) {
    super(message);
    this.name = 'CardioSegmentError';
    this.reason = reason;
    this.segmentId = segmentId;
  }
}

export type StrengthSetLifecycleReason =
  /** Removing or hiding it would destroy something the user recorded. */
  | 'set_has_recorded_work'
  /** Strength sets belong to strength activities; a cardio activity owns segments. */
  | 'activity_is_not_strength'
  /** Copy was asked for on an activity that has no set to copy yet. */
  | 'no_set_to_copy'
  /** The set is marked done, so its values are closed to an ordinary save. */
  | 'set_is_completed'
  /** A reorder named a set of rows that is not the activity's own set. */
  | 'set_order_mismatch';

/**
 * Raised when a strength change would lose recorded work or contradict the stored order.
 *
 * Separate from `CardioSegmentError` for the same reason that one is separate from
 * `SessionLifecycleError`: the two describe different records, and a caller reacts to
 * them differently. It carries the set id so a card can explain a refusal in place
 * instead of showing a page-level failure.
 */
export class StrengthSetError extends Error {
  readonly reason: StrengthSetLifecycleReason;
  readonly setId: string | undefined;

  constructor(reason: StrengthSetLifecycleReason, message: string, setId?: string) {
    super(message);
    this.name = 'StrengthSetError';
    this.reason = reason;
    this.setId = setId;
  }
}

/**
 * Whether a recorded session may be corrected.
 *
 * The mirror image of `isMutableSessionStatus`: an in-progress session belongs to the
 * workout screen, and a finished or cancelled one belongs to History. Exactly one of the
 * two is true at any moment, which is what stops the same rows being edited from two
 * screens under two different sets of rules.
 */
export function isCorrectableSessionStatus(status: SessionStatus): boolean {
  return isTerminalSessionStatus(status);
}

/**
 * Refuses a correction, a deletion, or a restore that must not happen.
 *
 * Deletion is checked first because it is the more informative refusal: telling someone
 * their edit was refused because the workout is in the trash points at the action that
 * fixes it, while "not correctable" leaves them guessing.
 */
export function assertSessionIsCorrectable(
  session: { id: string; status: SessionStatus; deletedAt?: string | undefined },
  options: { allowDeleted?: boolean } = {},
): void {
  if (session.deletedAt !== undefined && options.allowDeleted !== true) {
    throw new SessionLifecycleError(
      'session_deleted',
      `Session "${session.id}" is in the trash and must be restored before it can be changed`,
    );
  }
  if (!isCorrectableSessionStatus(session.status)) {
    throw new SessionLifecycleError(
      'session_in_progress',
      `Session "${session.id}" is still in progress and is changed on the workout screen`,
    );
  }
}

export function assertSessionIsEditable(status: SessionStatus, sessionId: string): void {
  if (!isMutableSessionStatus(status)) {
    throw new SessionLifecycleError(
      'session_not_editable',
      `Session "${sessionId}" is ${status} and no longer accepts changes`,
    );
  }
}

/**
 * Elapsed time is always derived from the persisted start instant, never accumulated by a
 * ticking counter. A counter drifts, resets on reload, and stops while the phone sleeps;
 * subtracting two timestamps survives all three.
 */
export function elapsedSecondsSince(startedAtIso: string, now: Date): number {
  const started = Date.parse(startedAtIso);
  if (Number.isNaN(started)) {
    throw new TypeError(`elapsedSecondsSince received an unparsable timestamp: ${startedAtIso}`);
  }
  const elapsedMs = now.getTime() - started;
  // A clock that moved backwards must not render a negative duration.
  return elapsedMs <= 0 ? 0 : Math.floor(elapsedMs / 1000);
}
