/**
 * Fills `{placeholder}` slots in a centralized string.
 *
 * Interpolation lives here rather than in components so a translation can reorder its
 * placeholders freely. Values are substituted as plain text and the result is rendered as
 * text -- there is no HTML path here, by design.
 */
export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/** Picks the singular or plural form and fills in the count. */
export function formatCount(one: string, other: string, count: number): string {
  return formatMessage(count === 1 ? one : other, { count });
}
