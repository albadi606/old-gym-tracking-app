import type { ReactNode } from 'react';

import { useStrings } from '../../i18n/context.ts';

/**
 * What is true about this app and the user's data, stated plainly.
 *
 * It is a list rather than a paragraph because each line is a separate promise, and a
 * promise buried in prose is one nobody reads. Two of them are uncomfortable and are here
 * for exactly that reason: clearing site data destroys the only copy, and an exported
 * backup is readable by anyone who opens it. A privacy section that only lists
 * reassurances is marketing.
 */
export function PrivacySection(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.settings;

  return (
    <section className="card" aria-labelledby="settings-privacy-heading">
      <h2 id="settings-privacy-heading" className="card__heading">
        {copy.privacyTitle}
      </h2>
      <ul className="prose-list">
        <li>{copy.privacyStorage}</li>
        <li>{copy.privacyNoNetwork}</li>
        <li>{copy.privacyNoSync}</li>
        <li>{copy.privacyClearing}</li>
        <li>{copy.privacyBackupContents}</li>
        <li>{copy.privacyBackupNotEncrypted}</li>
        <li>{copy.privacyChecksum}</li>
      </ul>
    </section>
  );
}
