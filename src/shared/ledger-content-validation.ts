import type { LedgerEntryType, LedgerLocation } from './ledger'
import { validateLedgerLocation } from './ledger-location-validation'
import {
  DECISION_STATUSES,
  invalidValidation,
  isObject,
  LEDGER_TYPES,
  PRIORITIES,
  SEVERITIES
} from './ledger-validation-primitives'

const required: Record<LedgerEntryType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}

export function validateLedgerContent(
  type: LedgerEntryType,
  content: Record<string, unknown>
): void {
  if (!LEDGER_TYPES.includes(type) || !isObject(content)) {
    invalidValidation('invalid-type', `Unsupported ledger entry type: ${String(type)}`)
  }
  for (const field of required[type]) {
    const value = content[field]
    if (field === 'file' || field === 'file_under_test') {
      try {
        validateLedgerLocation(value as LedgerLocation)
      } catch {
        invalidValidation(
          'invalid-content',
          `Required field must be a nonempty string or structured location: ${field}`,
          { field }
        )
      }
    } else if (typeof value !== 'string' || !value.trim()) {
      invalidValidation(
        'invalid-content',
        `Required field must be a nonempty string or structured location: ${field}`,
        { field }
      )
    }
  }
  if (type === 'bug' && !SEVERITIES.includes(content.severity as never)) {
    invalidValidation('invalid-enum', 'Invalid severity')
  }
  if (type === 'deferred' && !PRIORITIES.includes(content.priority as never)) {
    invalidValidation('invalid-enum', 'Invalid priority')
  }
  if (type === 'decision' && !DECISION_STATUSES.includes(content.status as never)) {
    invalidValidation('invalid-enum', 'Invalid decision status')
  }
}
