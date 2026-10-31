/**
 * Case- and accent-insensitive SQL text expression for parameterized search.
 * The caller must pass a normalized (lowercase, diacritic-free) parameter.
 */
export function normalizedSqlText(column: string): string {
  return `translate(lower(coalesce(${column}, '')), 'áéíóúüñ', 'aeiouun')`;
}
