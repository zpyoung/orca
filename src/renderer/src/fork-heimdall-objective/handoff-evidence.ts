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

function isObjectiveHandoffEvidence(value: unknown): value is HandoffEvidencePayload {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<HandoffEvidencePayload>
  return (
    isNonEmptyString(candidate.sitterWatcherId) &&
    isNonEmptyString(candidate.reviewUrl) &&
    candidate.reachedRung === 'hosted-review' &&
    isNonEmptyString(candidate.contentIdentity)
  )
}

function isObjectiveHandoffOrigin(value: unknown): value is HandoffOriginPayload {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<HandoffOriginPayload>
  if (
    !isNonEmptyString(candidate.objectiveWatcherId) ||
    !isNonEmptyString(candidate.objectiveTerminalEventId) ||
    !isNonEmptyString(candidate.contentIdentity) ||
    candidate.reachedRung !== 'hosted-review' ||
    typeof candidate.inheritedBudget !== 'object' ||
    candidate.inheritedBudget === null ||
    typeof candidate.derivedCapabilities !== 'object' ||
    candidate.derivedCapabilities === null
  ) {
    return false
  }
  return (
    isLimit(candidate.inheritedBudget.wallClockActiveMs) &&
    isLimit(candidate.inheritedBudget.turns) &&
    isCapabilityMode(candidate.derivedCapabilities.updateBranch) &&
    isCapabilityMode(candidate.derivedCapabilities.resolveConflicts) &&
    isCapabilityMode(candidate.derivedCapabilities.fixChecks) &&
    isCapabilityMode(candidate.derivedCapabilities.merge)
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
