import { describe, expect, it } from 'vitest';

import { NAV_DESTINATIONS } from '../shared/navigation/routes.ts';
import {
  CARDIO_MODES,
  INCLINE_TYPES,
  LOAD_BASES,
  SEGMENT_STATUSES,
  SESSION_STATUSES,
} from '../domain/enums.ts';
import { en } from './en.ts';
import { applyDocumentLocale, DEFAULT_LOCALE_CODE, LOCALES, resolveLocale } from './locales.ts';

describe('locales', () => {
  it('ships English only, and says so honestly', () => {
    expect(Object.keys(LOCALES)).toEqual(['en']);
    expect(DEFAULT_LOCALE_CODE).toBe('en');
  });

  it('falls back to the default locale for an unknown code', () => {
    expect(resolveLocale('fr').code).toBe('en');
    expect(resolveLocale().strings).toBe(en);
  });

  it('applies language and direction at the document boundary', () => {
    applyDocumentLocale(document, resolveLocale('en'));
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');

    // A right-to-left locale flips the whole layout without any component change.
    applyDocumentLocale(document, { code: 'ar', name: 'العربية', dir: 'rtl', strings: en });
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');

    applyDocumentLocale(document, resolveLocale('en'));
  });
});

describe('string resources', () => {
  it('has no empty copy', () => {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        expect(value.length, `empty string at ${path}`).toBeGreaterThan(0);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, `${path}.${key}`);
      }
    };
    walk(en, 'en');
  });

  it('labels every load basis and incline type the domain can store', () => {
    // Derived from the enums, so adding a vocabulary member without copy fails here.
    expect(Object.keys(en.loadBasis).sort()).toEqual([...LOAD_BASES].sort());
    expect(Object.keys(en.inclineType).sort()).toEqual([...INCLINE_TYPES].sort());
    expect(Object.keys(en.nav).sort()).toEqual(
      NAV_DESTINATIONS.map((destination) => destination.key).sort(),
    );
  });

  it('labels every cardio mode, segment status, and session status', () => {
    expect(Object.keys(en.cardioMode).sort()).toEqual([...CARDIO_MODES].sort());
    expect(Object.keys(en.segmentStatus).sort()).toEqual([...SEGMENT_STATUSES].sort());
    expect(Object.keys(en.sessionStatus).sort()).toEqual([...SESSION_STATUSES].sort());
  });
});
