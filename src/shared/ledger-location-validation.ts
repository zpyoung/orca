import type { LedgerLocation } from './ledger'
import { invalidValidation, isObject, positiveInt } from './ledger-validation-primitives'

export function validateLedgerLocation(location: LedgerLocation): LedgerLocation {
  if (
    !isObject(location) ||
    typeof location.path !== 'string' ||
    !isObject(location.base) ||
    typeof location.base.id !== 'string' ||
    !['project', 'workspace'].includes(location.base.kind as string)
  ) {
    invalidValidation('invalid-location', 'Location requires path and an explicit base')
  }
  if (location.line !== undefined && !positiveInt(location.line)) {
    invalidValidation('invalid-location', 'Location line must be a positive safe integer')
  }
  if (location.external !== undefined && typeof location.external !== 'boolean') {
    invalidValidation('invalid-location', 'Invalid external flag')
  }
  if (location.host !== undefined && typeof location.host !== 'string') {
    invalidValidation('invalid-location', 'Invalid location host')
  }
  if (location.external === true && (typeof location.host !== 'string' || !location.host.trim())) {
    invalidValidation('invalid-location', 'External locations require a host')
  }
  return { ...location }
}
