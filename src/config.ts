/**
 * Build-wide constants. Kept out of the domain and database layers' import graphs'
 * feature code so a value change is a one-line, reviewable edit.
 */
export const APP_VERSION = '0.1.0';

/**
 * Defaults written into the settings singleton the first time the database is seeded.
 *
 * These are preferences, not recorded facts. `firstDayOfWeek` follows ISO-8601 (Monday)
 * so the start of the week is consistent.
 */
export const DEFAULT_SETTINGS = {
  preferredLoadUnit: 'kg',
  preferredDistanceUnit: 'km',
  themePreference: 'system',
  localeCode: 'en',
  firstDayOfWeek: 1,
  defaultRestSeconds: 90,
  loadIncrementKg: 2.5,
  loadIncrementLb: 5,
  backupReminderDays: 14,
} as const;
