import { useEffect, useState } from 'react';

import { type Clock, systemClock } from '../../domain/clock.ts';
import { elapsedSecondsSince } from '../../domain/workout/lifecycle.ts';

/**
 * Seconds since the session was persisted as started.
 *
 * The value is *derived on every render* from the stored `startedAt`, and the interval
 * only nudges the component to render again. That distinction is the whole design: a
 * counter that accumulates its own ticks drifts, resets to zero on reload, and stops
 * while a phone is asleep in a pocket, whereas subtracting two instants survives all
 * three and needs no database write per second.
 *
 * The clock is injectable so a test can assert an exact elapsed time instead of waiting
 * for real seconds to pass.
 */
export function useElapsedSeconds(startedAtIso: string, clock: Clock = systemClock): number {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setTick((value) => value + 1);
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);

  return elapsedSecondsSince(startedAtIso, clock.now());
}
