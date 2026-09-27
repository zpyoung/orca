import { LedgerError, type LedgerActor, type LedgerEntryType, type LedgerOwner } from './ledger'

export const LEDGER_TYPES: readonly LedgerEntryType[] = [
  'bug',
  'deferred',
  'test-gap',
  'proposal',
  'decision'
]
export const STATES = ['open', 'resolved', 'archived'] as const
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export const PRIORITIES = ['high', 'medium', 'low'] as const
export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded'] as const

export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1
export const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'
export const isoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  value === new Date(value).toISOString()
export const validOwner = (value: unknown, tier?: unknown): value is LedgerOwner =>
  isObject(value) &&
  (value.tier === 'project' || value.tier === 'group') &&
  (tier === undefined || value.tier === tier) &&
  typeof value.id === 'string' &&
  value.id.length > 0
export const validActor = (value: unknown): value is LedgerActor =>
  isObject(value) &&
  ['human', 'agent', 'import', 'unknown'].includes(value.kind as string) &&
  optionalString(value.tool) &&
  (value.model === null || typeof value.model === 'string') &&
  (value.providerSessionId === null || typeof value.providerSessionId === 'string') &&
  (value.sourceAnchor === undefined || typeof value.sourceAnchor === 'string') &&
  (value.initiator === undefined || validActor(value.initiator))

export function invalidValidation(
  code: string,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new LedgerError(code, message, details)
}
