/**
 * Handing a file to the browser.
 *
 * Two things are deliberate and both are about honesty.
 *
 * **The object URL is revoked.** Every `createObjectURL` pins its Blob in memory until it
 * is released, and a backup Blob can be tens of megabytes. It is revoked on the next task
 * rather than immediately, because some browsers have not finished reading the URL by the
 * time the click handler returns.
 *
 * **Starting a download is not saving a file.** The page is told the browser was *asked*;
 * it is never told the file was written. A page has no way to know whether the user chose
 * a folder, cancelled the dialog, or had the download blocked, so any copy claiming "saved"
 * would be a claim the app cannot support -- and this one matters, because the next thing
 * the user may do is destroy the data the file was supposed to protect.
 */

export interface DownloadRequest {
  filename: string;
  text: string;
  mimeType?: string;
}

export type DownloadOutcome = 'requested' | 'unsupported';

export function downloadTextFile({
  filename,
  text,
  mimeType = 'application/json',
}: DownloadRequest): DownloadOutcome {
  if (typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') {
    return 'unsupported';
  }

  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return 'requested';
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

/**
 * A filename that sorts chronologically and cannot collide by accident.
 *
 * The date is the export instant in UTC, punctuation removed, because a colon is not a
 * legal filename character on every platform the user might copy the file to.
 */
export function backupFileName(exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
  return `gym-tracker-backup-${stamp}.json`;
}
