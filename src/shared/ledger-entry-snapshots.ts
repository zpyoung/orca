import type { LedgerEntry } from './ledger'

export function cloneLedger<T>(value: T): T {
  return structuredClone(value)
}

export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  return [
    ...new Set(
      [...Object.keys(before), ...Object.keys(after)].filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
      )
    )
  ]
}

export function importedFieldsEqual(
  entry: LedgerEntry,
  baseline: Record<string, unknown>,
  value: Record<string, unknown>
): boolean {
  return Object.keys({ ...baseline, ...value }).every(
    (key) => JSON.stringify(entry.content[key]) === JSON.stringify(baseline[key])
  )
}
