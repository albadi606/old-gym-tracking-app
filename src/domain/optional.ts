/**
 * Building records under `exactOptionalPropertyTypes`.
 *
 * With that flag on, `{ notes: undefined }` is not the same as `{}`: the first says the
 * key is present and holds `undefined`, which a strict schema rejects and IndexedDB would
 * happily store as a present-but-empty field. Records assembled here therefore have to
 * omit an absent value rather than set it to `undefined`.
 *
 * Written out by hand that is a conditional spread per field, and a workout record has
 * enough optional fields for that to become the place a mistake hides. `when` is the same
 * conditional spread, named once.
 */
export function when<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * The same idea for a value that is only meaningful above zero.
 *
 * A treadmill reading of `0` distance is not a recorded distance, it is an empty field,
 * and copying it forward as a planned target would invent a plan of zero kilometres.
 */
export function whenPositive<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined || value <= 0 ? {} : ({ [key]: value } as Record<K, number>);
}
