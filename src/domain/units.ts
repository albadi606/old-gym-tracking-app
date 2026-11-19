import type { LoadUnit } from './enums.ts';
import { DomainError } from './errors.ts';
import { assertNonNegativeFinite, assertNonNegativeInteger, roundToDecimals } from './numbers.ts';

/** The single exact conversion constant used everywhere in the app. */
export const POUNDS_PER_KILOGRAM = 2.2046226218;

export const GRAMS_PER_KILOGRAM = 1000;

/**
 * Display contract: loads are shown with at most two decimals. This is reversible
 * UI behaviour. The stored `loadValue`/`loadUnit` pair is never replaced by it.
 */
export const LOAD_DISPLAY_DECIMALS = 2;

/**
 * kg <-> lb round trips are lossy in binary floating point. Tests and equality
 * checks compare against this tolerance in grams rather than demanding exact
 * bit equality.
 */
export const LOAD_ROUND_TRIP_TOLERANCE_KG = 1e-9;

function assertLoadUnit(unit: unknown, field: string): LoadUnit {
  if (unit !== 'kg' && unit !== 'lb') {
    throw new DomainError('unsupported_unit', field, `${field} must be "kg" or "lb"`);
  }
  return unit;
}

export function kilogramsToPounds(kilograms: number): number {
  return assertNonNegativeFinite(kilograms, 'kilograms') * POUNDS_PER_KILOGRAM;
}

export function poundsToKilograms(pounds: number): number {
  return assertNonNegativeFinite(pounds, 'pounds') / POUNDS_PER_KILOGRAM;
}

/** Exact conversion with no rounding. Use for canonical maths, never for input replacement. */
export function convertLoad(value: number, from: LoadUnit, to: LoadUnit): number {
  const safeValue = assertNonNegativeFinite(value, 'value');
  const fromUnit = assertLoadUnit(from, 'from');
  const toUnit = assertLoadUnit(to, 'to');
  if (fromUnit === toUnit) {
    return safeValue;
  }
  return fromUnit === 'kg' ? kilogramsToPounds(safeValue) : poundsToKilograms(safeValue);
}

/**
 * Canonical storage form: integer grams. Only produced when the value/unit pair is
 * valid; an invalid pair throws instead of persisting a meaningless number.
 */
export function toCanonicalGrams(value: number, unit: LoadUnit): number {
  const kilograms = convertLoad(assertNonNegativeFinite(value, 'value'), unit, 'kg');
  return Math.round(kilograms * GRAMS_PER_KILOGRAM);
}

export function fromCanonicalGrams(grams: number, unit: LoadUnit): number {
  const kilograms = assertNonNegativeInteger(grams, 'grams') / GRAMS_PER_KILOGRAM;
  return convertLoad(kilograms, 'kg', unit);
}

/** Presentation rounding. Returns a number for rendering; callers keep the source value. */
export function roundLoadForDisplay(value: number, decimals = LOAD_DISPLAY_DECIMALS): number {
  return roundToDecimals(assertNonNegativeFinite(value, 'value'), decimals);
}

/**
 * Converts the *editable draft* shown when the user flips the kg/lb toggle.
 * The rounding here is deliberate so the field stays typable. It must only ever be
 * applied to an unsaved draft: a completed historical set keeps its original value.
 */
export function convertLoadForDraft(value: number, from: LoadUnit, to: LoadUnit): number {
  return roundLoadForDisplay(convertLoad(value, from, to));
}

export function formatLoadValue(value: number, decimals = LOAD_DISPLAY_DECIMALS): string {
  const rounded = roundLoadForDisplay(value, decimals);
  return String(rounded);
}
