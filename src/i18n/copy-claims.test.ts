import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en } from './en.ts';

/** Offline and installability claims are covered by the browser tests in e2e/pwa.spec.ts. */

/**
 * Only *affirmative* claims are offences.
 *
 * Honest negative statements -- "there is no cloud sync", "backups are not encrypted" --
 * are the point of this file rather than its target, and they contain exactly the words a
 * naive match would flag. So a match is discarded when a negation appears shortly before
 * it, within the same sentence, which is short enough that it cannot excuse a real claim
 * made a sentence later.
 */
const NEGATION = /\b(no|not|never|without|nothing|neither|nor)\b[^.]{0,24}$/i;

function affirmativeMatches(text: string, pattern: RegExp): boolean {
  const everyMatch = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  for (const match of text.matchAll(everyMatch)) {
    if (!NEGATION.test(text.slice(0, match.index))) {
      return true;
    }
  }
  return false;
}

/** Claims about capabilities this app does not have. */
const FORBIDDEN_CLAIMS: [string, RegExp][] = [
  ['cloud sync or a server', /\b(cloud sync|syncs? (?:to|with) (?:the )?cloud|our servers?)\b/i],
  ['an account', /\b(create an account|sign in|log in to|your account)\b/i],
  [
    'encrypted or protected backups',
    /\b(encrypted backup|backups? are (?:encrypted|protected|safe)|password[- ]protected)\b/i,
  ],
  ['a saved file, which the page cannot observe', /\b(?:backup|file) (?:was|has been) saved\b/i],
  ['analytics or tracking', /\b(we (?:collect|track)|analytics are|usage data is sent)\b/i],
];

/** Words that turn a neutral report into a scolding. The reminder must stay a fact. */
const GUILT_WORDS = /\b(streak|you should|failed to|missed|don't forget|reminder to stay)\b/i;

function collectStrings(value: unknown, path: string, into: [string, string][]): void {
  if (typeof value === 'string') {
    into.push([path, value]);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectStrings(child, `${path}.${key}`, into);
  }
}

// Vitest runs from the workspace root, so the shipped shell is read straight from disk.
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('shipped copy does not promise what this app cannot do', () => {
  const strings: [string, string][] = [];
  collectStrings(en, 'en', strings);

  it.each(FORBIDDEN_CLAIMS)('no user-visible string claims %s', (_label, pattern) => {
    const offenders = strings.filter(([, text]) => affirmativeMatches(text, pattern));
    expect(offenders).toEqual([]);
  });

  it.each(FORBIDDEN_CLAIMS)('index.html metadata does not claim %s', (_label, pattern) => {
    expect(affirmativeMatches(indexHtml, pattern)).toBe(false);
  });

  it('still catches an affirmative claim, so the negation guard cannot excuse everything', () => {
    const [, cloudPattern] = FORBIDDEN_CLAIMS[0]!;
    expect(affirmativeMatches('Your workouts sync to the cloud automatically.', cloudPattern)).toBe(
      true,
    );
    expect(affirmativeMatches('There is no cloud sync.', cloudPattern)).toBe(false);
    // A negation in an earlier sentence does not excuse a claim in a later one.
    expect(
      affirmativeMatches('There is no advertising. Your workouts sync to the cloud.', cloudPattern),
    ).toBe(true);
  });

  it('collected a meaningful number of strings, so an empty scan cannot pass silently', () => {
    expect(strings.length).toBeGreaterThan(40);
  });
});

describe('shipped copy states the things that are true and unwelcome', () => {
  it('says where data actually lives today', () => {
    expect(en.pages.settings.dataBody).toContain('this browser');
    expect(en.pages.settings.dataBody).toContain('IndexedDB');
    expect(en.pages.settings.privacyStorage).toContain('this device');
  });

  it('says that losing the browser profile loses the only copy', () => {
    expect(en.pages.settings.privacyClearing).toMatch(/clearing/i);
    expect(en.pages.settings.privacyClearing).toMatch(/only copy/i);
  });

  it('says a backup is readable and not encrypted', () => {
    expect(en.pages.settings.privacyBackupNotEncrypted).toMatch(/does not encrypt/i);
    expect(en.pages.settings.privacyBackupContents).toMatch(/readable/i);
  });

  it('describes the checksum as a checksum, with its limits', () => {
    const copy = en.pages.settings.privacyChecksum;
    expect(copy).toContain('SHA-256');
    expect(copy).toMatch(/not encryption/i);
    // The limit that matters: it is not a signature.
    expect(copy).toMatch(/both the contents and the checksum/i);
  });

  it('says the two devices do not share anything', () => {
    expect(en.pages.settings.privacyNoSync).toMatch(/separate data/i);
  });

  it('never claims a download was kept, only that the browser was asked', () => {
    expect(en.pages.settings.exportRequestedTitle).toMatch(/asked/i);
    expect(en.pages.settings.exportRequestedBody).toMatch(/cannot see/i);
  });
});

describe('the offline and update claims the app is now allowed to make', () => {
  it('describes offline support without promising a connection is never needed', () => {
    expect(en.pwa.offlineReadyBody).toMatch(/stored on this device/i);
    // The honest counterpart: a browser that cannot store the app says so.
    expect(en.pwa.offlineUnsupportedBody).toMatch(/still saved on this device/i);
  });

  it('never suggests an update can be applied during a workout', () => {
    expect(en.pwa.updateBlockedBody).toMatch(/finish or cancel/i);
    expect(en.pwa.updateBody).toMatch(/reloads the app/i);
  });

  it('treats a refused install as a choice rather than an error', () => {
    expect(en.pwa.installDismissedBody).not.toMatch(/error|failed|problem/i);
    expect(en.pwa.installManualBody).toMatch(/browser/i);
  });
});

describe('the backup reminder reports a fact rather than scolding', () => {
  it.each(Object.entries(en.backupReminder))('%s carries no guilt wording', (_key, text) => {
    expect(GUILT_WORDS.test(text)).toBe(false);
  });

  it('says what is true about where the data is, and offers the action', () => {
    expect(en.backupReminder.dueBody).toMatch(/only in this browser/i);
    expect(en.backupReminder.openSettings).toMatch(/settings/i);
  });
});
