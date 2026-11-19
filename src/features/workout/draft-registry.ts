/**
 * The barrier between a typed-but-unsaved value and the end of the workout.
 *
 * Every card that records something -- a treadmill segment, a strength set -- owns its own
 * draft and its own write. That is right while the
 * workout is running -- a save should not wait for the rest of the page -- but it left
 * Finish with no idea whether anything was still outstanding. Tapping Finish with a value
 * in a field, or just after its save had failed, closed the session and unmounted the
 * card, and the number the user had typed was gone with no way back to it.
 *
 * So the terminal actions ask every card first. Each card registers a handle here while
 * it is mounted; Finish and Cancel flush all of them and only proceed if every one is
 * durable. A flush that fails leaves the session in progress with the draft still on
 * screen and a retry available, which is the whole point: a workout that is still open
 * can be finished a second time, but a value that has been discarded is not recoverable.
 *
 * Cancel goes through the same barrier deliberately. Cancelling keeps everything already
 * recorded, so silently dropping the last thing typed would contradict that promise.
 *
 * ## Why the registry, and not each card, owns the terminal edit claim
 *
 * Flushing a card is not the same as finishing the workout, and the gap between them is
 * long enough to type into. Each card claimed its own draft for the duration of its own
 * `flush` and handed it straight back when that flush returned -- but `flushAll` is
 * sequential and the session write comes after all of it. So the first card was editable
 * again while the last card was still flushing, and every card was editable while
 * `finishSession` or `cancelSession` was in the air. An edit made in either window was
 * visible, owned, and then unmounted with the session that closed over it.
 *
 * The claim therefore belongs to the thing that spans the whole operation. A confirmed
 * Finish or Cancel claims **every** registered card synchronously, before the first flush,
 * and holds all of them until the terminal write settles: on success the cards unmount with
 * the session, and on any failure -- a refused flush or a refused session write -- every
 * claim is released so the still-open workout is editable and retryable. Claims are keyed
 * by holder, so a card's own `flush` releasing its own claim cannot hand back a draft the
 * session still owns, and a card that mounts mid-operation is claimed as it registers.
 */

/** Why a flush could not make a card durable. */
export type DraftBlockReason =
  /** The draft does not parse, so it was never storable in the first place. */
  | 'invalid'
  /** The write was attempted and refused -- storage full, database busy, quota. */
  | 'failed';

export class DraftBlockedError extends Error {
  readonly reason: DraftBlockReason;

  constructor(reason: DraftBlockReason, message: string) {
    super(message);
    this.name = 'DraftBlockedError';
    this.reason = reason;
  }
}

export interface DraftHandle {
  /** Names the card in a message the user has to act on, e.g. "Segment 2: Run", "Set 3". */
  label: string;
  /**
   * Makes this card durable, or throws.
   *
   * It must wait for any write already in flight, save anything still unsaved, and throw
   * a `DraftBlockedError` when it cannot -- never resolve while something is outstanding.
   */
  flush: () => Promise<void>;
  /**
   * Refuses further edits to this card's draft on behalf of `holder`, synchronously.
   *
   * The card's fields also render disabled, but that is how the refusal is *shown*; the
   * refusal itself must be true the instant this returns, before React has re-rendered
   * anything, or a keystroke already on its way would still mint a newer revision.
   */
  lockEdits: (holder: string) => void;
  /** Gives the draft back to `holder` only. Another holder's claim survives. */
  releaseEdits: (holder: string) => void;
}

export type FlushOutcome = { ok: true } | { ok: false; reason: DraftBlockReason; label: string };

/**
 * The set of drafts currently on screen -- cardio segments and strength sets alike.
 *
 * A mutable object held in a ref rather than React state: registering must not re-render,
 * and the terminal action needs the state of the drafts *now*, not the state they had at
 * the last render.
 */
export class WorkoutDraftRegistry {
  private readonly handles = new Map<string, DraftHandle>();
  /**
   * The session-terminal actions currently holding every card's draft.
   *
   * A set rather than a flag, for the reason every other holder set in this feature is a
   * set: two claims must never be able to release each other. It is also what a card
   * registering mid-operation is claimed with, so a remount cannot reappear editable while
   * the workout is closing around it.
   */
  private readonly terminalHolders = new Set<string>();

  /** Registers a card and returns the function that removes it again on unmount. */
  register(id: string, handle: DraftHandle): () => void {
    this.handles.set(id, handle);
    for (const holder of this.terminalHolders) {
      handle.lockEdits(holder);
    }
    return () => {
      // Only remove the handle still stored, so a re-registration during a React
      // remount is not deleted by the previous effect's cleanup.
      if (this.handles.get(id) === handle) {
        this.handles.delete(id);
      }
    };
  }

  get size(): number {
    return this.handles.size;
  }

  /**
   * Flushes every registered draft, stopping at the first one that cannot be made durable.
   *
   * Sequential on purpose. Each flush is a database write, and reporting *which* card
   * needs attention is more useful than reporting that some unspecified one of five did.
   */
  async flushAll(): Promise<FlushOutcome> {
    for (const handle of [...this.handles.values()]) {
      try {
        await handle.flush();
      } catch (error) {
        const reason = error instanceof DraftBlockedError ? error.reason : 'failed';
        return { ok: false, reason, label: handle.label };
      }
    }
    return { ok: true };
  }

  /**
   * Claims every registered card for a session-terminal action, synchronously.
   *
   * Called at the moment Finish or Cancel is accepted and before the first flush begins,
   * so there is no instant in which one card has been declared durable and is editable
   * again while the operation that declared it is still running.
   */
  claimAll(holder: string): void {
    this.terminalHolders.add(holder);
    for (const handle of this.handles.values()) {
      handle.lockEdits(holder);
    }
  }

  /**
   * Hands every card back, for this holder only.
   *
   * Called when a flush is refused or the terminal write fails -- never on success, where
   * the cards unmount with the session they belonged to and releasing them would briefly
   * reopen a workout that has already closed.
   */
  releaseAll(holder: string): void {
    if (!this.terminalHolders.delete(holder)) {
      return;
    }
    for (const handle of this.handles.values()) {
      handle.releaseEdits(holder);
    }
  }
}
