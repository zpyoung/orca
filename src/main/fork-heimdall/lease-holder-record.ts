export type LeaseHolderRecord = {
  holder: string
  watcherId: string
  acquiredAtMs: number
  ttlMs: number
  released: boolean
}

export type LeaseHolderReadResult =
  | { status: 'complete'; record: LeaseHolderRecord }
  | { status: 'incomplete'; freshnessPath: string }

export function parseLeaseHolderRecord(value: string): LeaseHolderRecord {
  const parsed: unknown = JSON.parse(value)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('holder' in parsed) ||
    typeof parsed.holder !== 'string' ||
    parsed.holder.length === 0 ||
    !('watcherId' in parsed) ||
    typeof parsed.watcherId !== 'string' ||
    parsed.watcherId.length === 0 ||
    !('acquiredAtMs' in parsed) ||
    typeof parsed.acquiredAtMs !== 'number' ||
    !Number.isFinite(parsed.acquiredAtMs) ||
    !('ttlMs' in parsed) ||
    typeof parsed.ttlMs !== 'number' ||
    !Number.isSafeInteger(parsed.ttlMs) ||
    parsed.ttlMs <= 0 ||
    !('released' in parsed) ||
    typeof parsed.released !== 'boolean'
  ) {
    throw new Error('Lease holder record is malformed')
  }
  return {
    holder: parsed.holder,
    watcherId: parsed.watcherId,
    acquiredAtMs: parsed.acquiredAtMs,
    ttlMs: parsed.ttlMs,
    released: parsed.released
  }
}
