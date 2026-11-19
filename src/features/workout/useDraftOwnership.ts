import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Who owns what is in the fields right now: the user, or the database.
 *
 * A card follows its stored record, so a reload -- or a resume after the page was closed --
 * shows what the database actually holds. But a save also replaces the record, and a write
 * takes long enough for the user to have kept typing, so adopting every incoming record
 * unconditionally would throw an entry away mid-flight.
 *
 * Both cards used to answer that with value equality: adopt when the draft still equals the
 * draft built from the record last adopted. Equality is only a *proxy* for ownership, and it
 * is wrong in exactly the case a person at a machine produces -- **typing away from a value
 * and typing it back**:
 *
 * 1. reps `10` are saved and adopted, so the draft and the last adopted values are both `10`;
 * 2. the user types `12` and blurs, so that write starts;
 * 3. the user corrects it back to `10` before the write lands;
 * 4. `12` lands. The draft (`10`) still equals the last adopted values (`10`), so the card
 *    calls itself untouched and replaces the field with `12`;
 * 5. the following blur finds the draft equal to the record and writes nothing.
 *
 * The screen and the database both end at `12`, and the last thing the user did was type
 * `10`. Every guard involved was working; what they were comparing could not tell "the user
 * has no edit here" apart from "the user's edit happens to look like the old value".
 *
 * So ownership is tracked explicitly, and by revision rather than by value. Every user edit
 * mints a new revision, **including one that restores a value that was already stored**, and
 * a write hands ownership back only by acknowledging the exact revision it made durable. An
 * older write landing can therefore never mark a newer draft clean, and while a draft is
 * owned no incoming record is adopted over it.
 *
 * What is deliberately unchanged: with no edit outstanding the stored record is still
 * adopted, so a reload or a repository refresh follows the database; a draft the user has
 * touched stays theirs until a write of that exact revision succeeds, which is what keeps an
 * invalid or failed entry on the screen and retryable.
 *
 * The two counters are refs, and the adoption decision reads them **after** the commit
 * that delivered the record rather than during it. Mirroring them into state and
 * consulting the mirror while rendering made the guard a derived fact that has to be kept
 * correct by hand at every call site: `editDraft` increments the revision synchronously
 * and can only *schedule* any state beside it. A layout effect reads the counters
 * themselves, at a point where every edit committed so far is already in them, and runs
 * before the browser paints -- so the card still never shows a record it was not entitled
 * to adopt, and the thing deciding is the same counter the writes acknowledge.
 *
 * ## Why the same hook also locks editing
 *
 * Preserving a newer edit on screen is only half an answer. `Mark done` captures the draft
 * and the revision it will store, and then the row it writes comes back **closed** -- every
 * field disabled, Save replaced by Reopen. An edit made while that write was outstanding was
 * correctly kept in the draft by the rule above, and then had nowhere to go: the card said
 * `Done` and `Not saved yet` at the same time, and a reload rebuilt the completed row and
 * lost the entry. Skip and Remove had the same shape one step further along -- they flush,
 * and then close or destroy a row that a later edit was never written to.
 *
 * So an action that will close, hide, or destroy the card takes the draft with it. From the
 * moment it is accepted until it settles, `editDraft` refuses and the fields render
 * disabled, which makes "the newest visible draft" and "what was stored" the same thing by
 * construction rather than by timing. When the action fails, the claim is released and the
 * card is editable again with every value intact.
 *
 * This is deliberately *not* the old `disabled={mutation.isPending}` on the buttons: an
 * ordinary autosave locks nothing, so a blur followed by a tap still reaches its button.
 * Only an action that ends the card's editable life claims the draft.
 */
export interface DraftOwnership<TDraft> {
  /** What the fields show. */
  draft: TDraft;
  /**
   * Applies a user edit and mints a new revision.
   *
   * Every path that changes the draft on the user's behalf goes through this -- typing, a
   * step chip, a unit toggle -- because a revision is minted by the *act* of editing, not by
   * the values changing. Restoring a previous value is a new edit and must supersede a write
   * that is still in flight.
   */
  editDraft: (update: (current: TDraft) => TDraft) => void;
  /**
   * The revision now on screen, to be handed back to {@link DraftOwnership.acknowledge} by
   * whatever write stores it. Read it when the write is *requested*, not when it settles.
   */
  currentRevision: () => number;
  /**
   * Whether the user holds an edit that no successful write has acknowledged.
   *
   * A card asks this before deciding it has nothing to save: a draft that matches the record
   * on screen can still be a newer correction than the write that is in flight.
   */
  hasUnacknowledgedEdit: () => boolean;
  /** Records that `revision` is durably stored. A stale revision never clears a newer edit. */
  acknowledge: (revision: number) => void;
  /**
   * Whether an action that will close, hide, or destroy this card is outstanding.
   *
   * The card renders its fields disabled while this holds, so the refusal below is
   * something the user can see rather than a keystroke that silently does nothing.
   */
  editsLocked: boolean;
  /**
   * Takes responsibility for the draft on behalf of `holder`, refusing edits until it is
   * released. Re-entrant across different holders; each releases only its own claim.
   */
  lockEdits: (holder: string) => void;
  releaseEdits: (holder: string) => void;
}

export interface DraftOwnershipOptions<TRecord, TDraft> {
  /** The stored record this card shows. */
  record: TRecord;
  /** Changes whenever the stored record changes; `updatedAt` in both cards. */
  version: string;
  /**
   * Builds a draft from the record. `current` is the draft being replaced, or `undefined`
   * for the first build, so a card can keep a presentation choice the record does not hold
   * -- the strength card's displayed load unit.
   */
  build: (record: TRecord, current: TDraft | undefined) => TDraft;
  /** Runs in the render that adopts a record, so the card can clear stale field errors. */
  onAdopt?: () => void;
}

export function useDraftOwnership<TRecord, TDraft>({
  record,
  version,
  build,
  onAdopt,
}: DraftOwnershipOptions<TRecord, TDraft>): DraftOwnership<TDraft> {
  const [draft, setDraft] = useState<TDraft>(() => build(record, undefined));
  /** Counts the user's edits. Monotonic, so "newer" is a comparison and not a guess. */
  const editRevision = useRef(0);
  /** The newest revision a write has reported durable. */
  const acknowledgedRevision = useRef(0);
  /**
   * The record version the draft was last built from, or last deliberately declined.
   *
   * A ref rather than state because the adoption decision is taken in a layout effect
   * beside the counters it compares, and all three have to be read at the same instant.
   */
  const seenVersion = useRef(version);
  /*
   * Every action currently holding the draft, keyed the way `useCardWrites` keys its
   * outstanding actions and for the same reason: two overlapping claims must not be able to
   * release each other. `editsLocked` is the state the fields render from; the set is the
   * ref an event handler reads synchronously, before React has re-rendered anything.
   */
  const editHolders = useRef(new Set<string>());
  const [editsLocked, setEditsLocked] = useState(false);

  /*
   * The whole rule, in one condition: a record may replace the fields only when the user
   * has no edit newer than the last revision a write acknowledged. Values are not
   * consulted, because a value cannot distinguish an untouched draft from a correction
   * that happens to restore what was there before.
   *
   * A layout effect, so the two counters can be read as they actually stand instead of
   * through a state mirror that a render could catch mid-update, and so the decision --
   * and any resulting rebuild -- still lands before the browser paints. The version guard
   * makes it a no-op on every other render, including the ones caused by the inline
   * `build` and `onAdopt` closures changing identity.
   */
  useLayoutEffect(() => {
    if (seenVersion.current === version) {
      return;
    }
    seenVersion.current = version;
    if (editRevision.current !== acknowledgedRevision.current) {
      return;
    }
    setDraft((current) => build(record, current));
    onAdopt?.();
  }, [version, record, build, onAdopt]);

  const editDraft = useCallback((update: (current: TDraft) => TDraft): void => {
    /*
     * Refused synchronously, before any state is touched. The disabled fields stop this
     * happening at all in a browser; this is the guard that makes it true regardless of how
     * the change arrived, and it is what stops an edit becoming an owned revision that the
     * closing write has already decided not to include.
     */
    if (editHolders.current.size > 0) {
      return;
    }
    // Minted outside the updater: React may invoke an updater twice, and an edit is one edit.
    editRevision.current += 1;
    setDraft(update);
  }, []);

  const currentRevision = useCallback((): number => editRevision.current, []);

  const hasUnacknowledgedEdit = useCallback(
    (): boolean => editRevision.current !== acknowledgedRevision.current,
    [],
  );

  const acknowledge = useCallback((revision: number): void => {
    /*
     * `Math.max` is the guard against adopting stale data. A write that started before the
     * user's latest edit still reports the revision *it* stored, and reporting an older
     * revision must leave the newer edit owned rather than declaring the card clean.
     */
    acknowledgedRevision.current = Math.max(acknowledgedRevision.current, revision);
  }, []);

  const lockEdits = useCallback((holder: string): void => {
    editHolders.current.add(holder);
    setEditsLocked(true);
  }, []);

  const releaseEdits = useCallback((holder: string): void => {
    editHolders.current.delete(holder);
    setEditsLocked(editHolders.current.size > 0);
  }, []);

  return {
    draft,
    editDraft,
    currentRevision,
    hasUnacknowledgedEdit,
    acknowledge,
    editsLocked,
    lockEdits,
    releaseEdits,
  };
}
