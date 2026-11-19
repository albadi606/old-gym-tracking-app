import type { ReactNode } from 'react';

import type { BackupPreview } from '../../domain/backup/index.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';

/**
 * What the chosen file holds, before anything is done with it.
 *
 * This exists so "Replace everything" is never a leap of faith. A confirmation that says
 * only "are you sure?" gives the reader nothing to be sure *about*; these are the facts
 * that would let somebody notice they had picked last year's file — when it was written,
 * how many workouts are in it, how they ended, and whether it was exported mid-workout.
 *
 * It is a description list rather than a table: each line is one labelled fact, and a
 * screen reader announces the label with the value without a grid to navigate.
 */
export interface ImportPreviewProps {
  preview: BackupPreview;
}

export function ImportPreview({ preview }: ImportPreviewProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.settings;

  const rows: [string, string][] = [
    [copy.previewMachines, String(preview.counts.machines)],
    [copy.previewCustom, String(preview.customMachines)],
    [copy.previewExercises, String(preview.counts.exercises)],
    [copy.previewTemplates, String(preview.counts.workoutTemplates)],
    [copy.previewWorkouts, String(preview.counts.workoutSessions)],
    [
      copy.previewBreakdownLabel,
      formatMessage(copy.previewWorkoutBreakdown, {
        completed: preview.sessionsByStatus.completed,
        cancelled: preview.sessionsByStatus.cancelled,
        inProgress: preview.sessionsByStatus.in_progress,
      }),
    ],
    [copy.previewDeleted, String(preview.deletedSessions)],
    [copy.previewSegments, String(preview.counts.cardioSegments)],
    [copy.previewSets, String(preview.counts.strengthSets)],
    [copy.previewPhotos, String(preview.userPhotos)],
  ];

  return (
    /*
     * A named region rather than a bare div: the preview is the thing a reader is asked to
     * check before a destructive action, so it should be reachable and announceable as one
     * named piece of the page.
     */
    <section className="import-preview" aria-labelledby="import-preview-heading">
      <h3 id="import-preview-heading" className="card__subheading">
        {copy.previewTitle}
      </h3>
      <p className="card__body">
        {formatMessage(copy.previewExportedAt, {
          date: new Date(preview.exportedAt).toLocaleString(),
          appVersion: preview.appVersion,
        })}{' '}
        {formatMessage(copy.previewFormat, {
          formatVersion: preview.formatVersion,
          schemaVersion: preview.appSchemaVersion,
        })}
      </p>
      <p className="card__body">{copy.previewIntegrityOk}</p>

      <dl className="import-preview__facts">
        {rows.map(([label, value]) => (
          <div className="import-preview__fact" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {preview.hasSessionInProgress ? (
        <p className="card__body">{copy.previewActiveWorkout}</p>
      ) : null}
    </section>
  );
}
