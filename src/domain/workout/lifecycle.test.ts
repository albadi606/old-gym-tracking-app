import { describe, expect, it } from 'vitest';

import {
  assertSessionIsEditable,
  elapsedSecondsSince,
  isMutableSessionStatus,
  isTerminalSessionStatus,
  planSessionTransition,
  SessionLifecycleError,
} from './lifecycle.ts';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

describe('which sessions accept changes', () => {
  it('accepts changes only while in progress', () => {
    expect(isMutableSessionStatus('in_progress')).toBe(true);
    expect(isMutableSessionStatus('completed')).toBe(false);
    expect(isMutableSessionStatus('cancelled')).toBe(false);
  });

  it('treats completed and cancelled as terminal', () => {
    expect(isTerminalSessionStatus('completed')).toBe(true);
    expect(isTerminalSessionStatus('cancelled')).toBe(true);
    expect(isTerminalSessionStatus('in_progress')).toBe(false);
  });

  it('refuses an edit to a closed session, naming why', () => {
    expect(() => {
      assertSessionIsEditable('in_progress', SESSION_ID);
    }).not.toThrow();

    for (const status of ['completed', 'cancelled'] as const) {
      try {
        assertSessionIsEditable(status, SESSION_ID);
        throw new Error('expected a lifecycle error');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionLifecycleError);
        expect((error as SessionLifecycleError).reason).toBe('session_not_editable');
      }
    }
  });
});

describe('finishing and cancelling', () => {
  it('applies either transition to a session in progress', () => {
    expect(planSessionTransition('in_progress', 'finish')).toBe('apply');
    expect(planSessionTransition('in_progress', 'cancel')).toBe('apply');
  });

  it('treats a repeat of the same transition as already applied, not as an error', () => {
    // This is what makes a double tap, a retry, and a resumed request all safe: the
    // second one asks for a state the session already reached.
    expect(planSessionTransition('completed', 'finish')).toBe('already_applied');
    expect(planSessionTransition('cancelled', 'cancel')).toBe('already_applied');
  });

  it('refuses a transition that would rewrite a decision already made', () => {
    expect(planSessionTransition('cancelled', 'finish')).toBe('refused');
    expect(planSessionTransition('completed', 'cancel')).toBe('refused');
  });
});

describe('elapsed time', () => {
  const started = '2026-09-04T05:00:00.000Z';

  it('is the difference between two instants, in whole seconds', () => {
    expect(elapsedSecondsSince(started, new Date('2026-09-04T05:16:00.000Z'))).toBe(960);
    expect(elapsedSecondsSince(started, new Date('2026-09-04T05:34:00.400Z'))).toBe(2040);
  });

  it('survives a gap, because it is never accumulated tick by tick', () => {
    // A phone asleep in a pocket for half an hour returns to the right number.
    expect(elapsedSecondsSince(started, new Date('2026-09-04T05:30:00.000Z'))).toBe(1800);
  });

  it('never reports a negative duration when the clock moves backwards', () => {
    expect(elapsedSecondsSince(started, new Date('2026-09-04T04:59:00.000Z'))).toBe(0);
  });

  it('rejects an unparsable start instant instead of returning NaN', () => {
    expect(() => elapsedSecondsSince('not a timestamp', new Date(started))).toThrow(TypeError);
  });
});
