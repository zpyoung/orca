/** Narrows a YAML-decoded value to a plain object map (excludes arrays and null). */
export function isPlainMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
