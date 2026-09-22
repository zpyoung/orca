import type {
  ApprovalEntry,
  ApprovalScope,
  AttemptEntry,
  AttemptResolvedEntry,
  EscalationEntry,
  OrchestrationEvidenceSource,
  WatcherLedger
} from './ledger-types'

export function sameApprovalScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return (
    left.actionKind === right.actionKind &&
    left.contentIdentity === right.contentIdentity &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

export function getLatestAttempts(ledger: WatcherLedger): readonly AttemptEntry[] {
  const latestById = new Map<string, AttemptEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'attempt') {
      continue
    }
    // Delete first so Map iteration preserves the append order of the latest revision.
    latestById.delete(entry.attemptId)
    latestById.set(entry.attemptId, entry)
  }
  return [...latestById.values()]
}

export function getLatestAttemptForFingerprint(
  ledger: WatcherLedger,
  fingerprint: string
): AttemptEntry | null {
  let latest: AttemptEntry | null = null
  for (const entry of getLatestAttempts(ledger)) {
    if (entry.fingerprint === fingerprint) {
      latest = entry
    }
  }
  return latest
}

export function getAttemptResolution(
  ledger: WatcherLedger,
  attemptId: string
): AttemptResolvedEntry | null {
  let latest: AttemptResolvedEntry | null = null
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt-resolved' && entry.attemptId === attemptId) {
      latest = entry
    }
  }
  return latest
}

export function getUnresolvedAttempts(ledger: WatcherLedger): readonly AttemptEntry[] {
  const resolvedAttemptIds = new Set<string>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt-resolved') {
      resolvedAttemptIds.add(entry.attemptId)
    }
  }
  return getLatestAttempts(ledger).filter(
    (entry) =>
      entry.state === 'settled' &&
      entry.effect === 'indeterminate' &&
      !resolvedAttemptIds.has(entry.attemptId)
  )
}

export function getInFlightAttempts(ledger: WatcherLedger): readonly AttemptEntry[] {
  const resolvedAttemptIds = new Set<string>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt-resolved') {
      resolvedAttemptIds.add(entry.attemptId)
    }
  }
  return getLatestAttempts(ledger).filter(
    (entry) =>
      !resolvedAttemptIds.has(entry.attemptId) &&
      (entry.state === 'attempted' || entry.state === 'running')
  )
}

export function hasPendingAttemptOutcome(ledger: WatcherLedger): boolean {
  const resolvedAttemptIds = new Set<string>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt-resolved') {
      resolvedAttemptIds.add(entry.attemptId)
    }
  }
  return getLatestAttempts(ledger).some(
    (entry) =>
      !resolvedAttemptIds.has(entry.attemptId) &&
      (entry.state === 'attempted' ||
        entry.state === 'running' ||
        (entry.state === 'settled' && entry.effect === 'indeterminate'))
  )
}

export function getLatestApproval(
  ledger: WatcherLedger,
  scope: ApprovalScope
): ApprovalEntry | null {
  let latest: ApprovalEntry | null = null
  for (const entry of ledger.entries) {
    if (entry.kind === 'approval' && sameApprovalScope(entry.scope, scope)) {
      latest = entry
    }
  }
  return latest
}

export function getLatestEscalations(ledger: WatcherLedger): readonly EscalationEntry[] {
  const latestById = new Map<string, EscalationEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'escalation') {
      continue
    }
    latestById.delete(entry.escalationId)
    latestById.set(entry.escalationId, entry)
  }
  return [...latestById.values()]
}

export function getLatestUnresolvedAwaitingApprovalEscalation(
  ledger: WatcherLedger,
  scope: ApprovalScope
): EscalationEntry | null {
  const logicalEscalations = getLatestEscalations(ledger)
  for (let index = logicalEscalations.length - 1; index >= 0; index -= 1) {
    const entry = logicalEscalations[index]!
    if (
      (entry.status === 'open' || entry.status === 'escalated') &&
      entry.escalationKind === 'awaiting-approval' &&
      entry.approvalScope !== undefined &&
      sameApprovalScope(entry.approvalScope, scope)
    ) {
      return entry
    }
  }
  return null
}

export function getLastDecidedContentIdentity(ledger: WatcherLedger): string | null {
  let latest: AttemptEntry | null = null
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt') {
      latest = entry
    }
  }
  return latest?.action.contentIdentity ?? null
}

export function hasOrchestrationSequence(ledger: WatcherLedger, sequence: number): boolean {
  return ledger.entries.some(
    (entry) => entry.kind === 'evidence' && entry.source?.sequence === sequence
  )
}

export function getLastOrchestrationSource(
  ledger: WatcherLedger
): OrchestrationEvidenceSource | null {
  let latest: OrchestrationEvidenceSource | null = null
  for (const entry of ledger.entries) {
    if (
      entry.kind === 'evidence' &&
      entry.source &&
      (latest === null || entry.source.sequence >= latest.sequence)
    ) {
      latest = entry.source
    }
  }
  return latest
}

export function hasTerminalEntry(ledger: WatcherLedger): boolean {
  return ledger.entries.some((entry) => entry.kind === 'terminal')
}
