import type { MuscleGroup } from '../enums.ts';
import { startOfLocalWeek } from '../history/grouping.ts';
import type { ProgressSession } from './filters.ts';

/**
 * Which muscle areas the logged strength work covered, week by week.
 *
 * Three things this is careful about:
 *
 * **The exercise decides the coverage, not the machine.** One cable station supports a
 * row, a curl, and a triceps push-down. Reading coverage off the physical equipment would
 * credit the same muscles whatever movement was performed on it.
 *
 * **A current classification applied to past logs.** The mapping comes from the exercise
 * records as they stand now, so correcting an exercise's muscles in the catalog changes
 * what earlier weeks are shown as covering. That is a deliberate choice -- it is the only
 * way a correction can ever fix history -- and the screen says so plainly rather than
 * implying the mapping was frozen at the time.
 *
 * **Unmapped work is named, not dropped.** An activity whose catalog identity degraded to
 * a snapshot has no exercise to read muscles from. Silently omitting it would report less
 * coverage than the week actually contained, and silently guessing from its name would
 * report coverage nobody can verify.
 *
 * **Only work the active filters selected.** The coverage is built from the strength
 * activities `selectProgressSessions` matched, not from every activity in the session, so
 * choosing one machine cannot leave another machine's muscles on the screen and choosing
 * Cardio cannot leave strength coverage there at all.
 *
 * Nothing here diagnoses an imbalance or prescribes an exercise. It reports what was
 * logged.
 */

export interface ExerciseMuscleMapping {
  exerciseId: string;
  primaryMuscles: readonly MuscleGroup[];
  secondaryMuscles: readonly MuscleGroup[];
}

export interface WeeklyMuscleCoverage {
  weekStartDayKey: string;
  /** Areas a mapped exercise names as primary. */
  primary: readonly MuscleGroup[];
  /** Areas named only as secondary that week. A primary area is never repeated here. */
  secondary: readonly MuscleGroup[];
  /** Recorded names of logged strength work whose exercise mapping is unavailable. */
  unmappedActivityNames: readonly string[];
  loggedStrengthActivityCount: number;
}

export interface MuscleCoverageSummary {
  /** Newest week first. Only weeks containing completed strength work appear. */
  weeks: readonly WeeklyMuscleCoverage[];
  /** True when any week contains work that could not be mapped. */
  hasUnmappedWork: boolean;
}

interface WeekDraft {
  primary: Set<MuscleGroup>;
  secondary: Set<MuscleGroup>;
  unmapped: Set<string>;
  loggedStrengthActivityCount: number;
}

export function summarizeMuscleCoverage(
  sessions: readonly ProgressSession[],
  mappings: readonly ExerciseMuscleMapping[],
  firstDayOfWeek: number,
): MuscleCoverageSummary {
  const byExerciseId = new Map(mappings.map((mapping) => [mapping.exerciseId, mapping]));
  const weeks = new Map<string, WeekDraft>();

  for (const { aggregate, localDayKey, work } of sessions) {
    const weekStart = startOfLocalWeek(localDayKey, firstDayOfWeek);
    let draft = weeks.get(weekStart);

    for (const activity of aggregate.activities) {
      /*
       * An activity counts as logged work only if a set under it was marked done *and*
       * matched the active filters -- which is one membership test, because the
       * selection decided both at once. A machine the user chose and never performed a
       * set on is not coverage, and neither is work the panel above has filtered out.
       */
      if (!work.strengthActivityIds.has(activity.id)) {
        continue;
      }

      if (draft === undefined) {
        draft = {
          primary: new Set<MuscleGroup>(),
          secondary: new Set<MuscleGroup>(),
          unmapped: new Set<string>(),
          loggedStrengthActivityCount: 0,
        };
        weeks.set(weekStart, draft);
      }
      draft.loggedStrengthActivityCount += 1;

      const mapping =
        activity.exerciseId === undefined ? undefined : byExerciseId.get(activity.exerciseId);
      if (mapping === undefined) {
        draft.unmapped.add(activity.snapshot.exerciseName ?? activity.displayName);
        continue;
      }
      for (const muscle of mapping.primaryMuscles) {
        draft.primary.add(muscle);
      }
      for (const muscle of mapping.secondaryMuscles) {
        draft.secondary.add(muscle);
      }
    }
  }

  const ordered = [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([weekStartDayKey, draft]) => ({
      weekStartDayKey,
      primary: [...draft.primary].sort(),
      // Primary and secondary stay distinguishable: an area worked as primary is not
      // repeated in the secondary list, where it would read as a second, weaker claim.
      secondary: [...draft.secondary].filter((muscle) => !draft.primary.has(muscle)).sort(),
      unmappedActivityNames: [...draft.unmapped].sort((a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' }),
      ),
      loggedStrengthActivityCount: draft.loggedStrengthActivityCount,
    }));

  return {
    weeks: ordered,
    hasUnmappedWork: ordered.some((week) => week.unmappedActivityNames.length > 0),
  };
}
