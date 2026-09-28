import type {
  HandoffEvidencePayload,
  HandoffOriginPayload
} from '../../../shared/fork-heimdall-objective/objective-handoff-policy'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isLimit(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

function isCapabilityMode(value: unknown): boolean {
  return value === 'off' || value === 'gated' || value === 'on'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isObjectiveHandoffEvidence(value: unknown): value is HandoffEvidencePayload {
  if (!isRecord(value)) {
    return false
  }
  return (
    isNonEmptyString(value.sitterWatcherId) &&
    isNonEmptyString(value.reviewUrl) &&
    value.reachedRung === 'hosted-review' &&
    isNonEmptyString(value.contentIdentity)
  )
}

function isObjectiveHandoffOrigin(value: unknown): value is HandoffOriginPayload {
  if (!isRecord(value)) {
    return false
  }
  if (
    !isNonEmptyString(value.objectiveWatcherId) ||
    !isNonEmptyString(value.objectiveTerminalEventId) ||
    !isNonEmptyString(value.contentIdentity) ||
    value.reachedRung !== 'hosted-review' ||
    !isRecord(value.inheritedBudget) ||
    !isRecord(value.derivedCapabilities)
  ) {
    return false
  }
  return (
    isLimit(value.inheritedBudget.wallClockActiveMs) &&
    isLimit(value.inheritedBudget.turns) &&
    isCapabilityMode(value.derivedCapabilities.updateBranch) &&
    isCapabilityMode(value.derivedCapabilities.resolveConflicts) &&
    isCapabilityMode(value.derivedCapabilities.fixChecks) &&
    isCapabilityMode(value.derivedCapabilities.merge)
  )
}

export function objectiveHandoffEvidence(
  ledger: WatcherLedger | null
): HandoffEvidencePayload | null {
  if (!ledger) {
    return null
  }
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry?.kind === 'evidence' &&
      entry.evidenceKind === 'handoff' &&
      isObjectiveHandoffEvidence(entry.payload)
    ) {
      return entry.payload
    }
  }
  return null
}

export function objectiveHandoffOrigin(ledger: WatcherLedger | null): HandoffOriginPayload | null {
  if (!ledger) {
    return null
  }
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry?.kind === 'evidence' &&
      entry.evidenceKind === 'handoff-origin' &&
      isObjectiveHandoffOrigin(entry.payload)
    ) {
      return entry.payload
    }
  }
  return null
}
