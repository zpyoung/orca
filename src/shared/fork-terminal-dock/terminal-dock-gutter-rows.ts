export const DEFAULT_GUTTER_ROWS = 5
export const MIN_GUTTER_ROWS = 3
export const MAX_GUTTER_ROWS = 15

/** Rounds a gutter row count and clamps it to the supported dock range. */
export function clampGutterRows(rows: number): number {
  return Math.min(MAX_GUTTER_ROWS, Math.max(MIN_GUTTER_ROWS, Math.round(rows)))
}
