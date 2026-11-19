import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Makes one user action produce exactly one write.
 *
 * A thumb on a phone produces two clicks far more often than a mouse does, and both
 * handlers run before React has processed a single `setState`. That is why disabling the
 * button is not, on its own, a guard: by the time the disabled attribute reaches the DOM,
 * the second submit has already started and minted its own record identity.
 *
 * So the real guard is `inFlight`, a ref checked and set synchronously before the first
 * `await`. The `isSubmitting` state exists only to *show* that something is happening;
 * correctness does not depend on it having been applied yet.
 *
 * The guard always releases, including on failure, so a refused save leaves the user able
 * to fix the problem and try again with the draft they already typed. `isActive` lets a
 * caller skip navigation or a state update if the component went away while the write was
 * in flight.
 */
export interface SubmitGuard {
  /** True while a submission is running. For display and for disabling a control. */
  isSubmitting: boolean;
  /** Starts `operation` unless one is already running. */
  submit: (operation: () => Promise<void>) => void;
  /** False once the component has unmounted. */
  isActive: () => boolean;
}

export function useSubmitGuard(): SubmitGuard {
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback((operation: () => Promise<void>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setIsSubmitting(true);

    void operation().finally(() => {
      inFlight.current = false;
      // A successful save usually navigates away; setting state on the unmounted form
      // would be pointless work and a warning.
      if (mounted.current) {
        setIsSubmitting(false);
      }
    });
  }, []);

  const isActive = useCallback(() => mounted.current, []);

  return { isSubmitting, submit, isActive };
}
