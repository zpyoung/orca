import type {
  ActionApprovalScope,
  ActionLedgerEntry,
  ApprovalLedgerEntry,
  DiscrepancyLedgerEntry,
  HostedReviewSitterAction,
  HostedReviewSitterLedger
} from './types'

export type ActionDisposition =
  | 'unseen'
  | 'in-flight'
  | 'completed'
  | 'retryable-failure'
  | 'ambiguous'

export function makeEvidenceKey(parts: readonly (string | number | null)[]): string {
  return JSON.stringify(parts)
}

export function makeActionKey(
  headSha: string,
  kind: HostedReviewSitterAction['kind'],
  evidenceKey: string
): string {
  return makeEvidenceKey([headSha, kind, evidenceKey])
}

export function approvalScopeForAction(action: HostedReviewSitterAction): ActionApprovalScope {
  if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
    return {
      action: action.kind,
      headSha: action.headSha,
      evidenceKey: action.evidenceKey,
      preparedCommitSha: action.preparedCommitSha
    }
  }
  return {
    action: action.kind,
    headSha: action.headSha,
    evidenceKey: action.evidenceKey
  }
}

function sameApprovalScope(left: ActionApprovalScope, right: ActionApprovalScope): boolean {
  return (
    left.action === right.action &&
    left.headSha === right.headSha &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

export function getLatestApproval(
  ledger: HostedReviewSitterLedger,
  scope: ActionApprovalScope
): ApprovalLedgerEntry | null {
  let latest: ApprovalLedgerEntry | null = null
  for (const entry of ledger.entries) {
    if (entry.kind !== 'approval' || !sameApprovalScope(entry.scope, scope)) {
      continue
    }
    if (!latest || entry.atMs >= latest.atMs) {
      latest = entry
    }
  }
  return latest
}

export function getLatestActionTransitions(
  ledger: HostedReviewSitterLedger
): readonly ActionLedgerEntry[] {
  const latestById = new Map<string, ActionLedgerEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'action') {
      continue
    }
    const previous = latestById.get(entry.actionId)
    if (!previous || entry.atMs >= previous.atMs) {
      latestById.set(entry.actionId, entry)
    }
  }
  return [...latestById.values()]
}

export function getLatestActionForKey(
  ledger: HostedReviewSitterLedger,
  actionKey: string
): ActionLedgerEntry | null {
  let latest: ActionLedgerEntry | null = null
  for (const entry of getLatestActionTransitions(ledger)) {
    if (entry.action.key !== actionKey) {
      continue
    }
    if (!latest || entry.atMs >= latest.atMs) {
      latest = entry
    }
  }
  return latest
}

export function getActionDisposition(
  ledger: HostedReviewSitterLedger,
  actionKey: string
): ActionDisposition {
  const latest = getLatestActionForKey(ledger, actionKey)
  if (!latest) {
    return 'unseen'
  }
  if (latest.state === 'attempted' || latest.state === 'running') {
    return 'in-flight'
  }
  if (latest.state === 'completed' || latest.effect === 'committed') {
    return 'completed'
  }
  return latest.effect === 'none' ? 'retryable-failure' : 'ambiguous'
}

export function getCompletedActionForKey(
  ledger: HostedReviewSitterLedger,
  actionKey: string
): ActionLedgerEntry | null {
  const entry = getLatestActionForKey(ledger, actionKey)
  if (!entry) {
    return null
  }
  return entry.state === 'completed' || entry.effect === 'committed' ? entry : null
}

export function getAmbiguousActions(
  ledger: HostedReviewSitterLedger,
  headSha?: string
): readonly ActionLedgerEntry[] {
  return getLatestActionTransitions(ledger).filter((entry) => {
    if (headSha && entry.action.headSha !== headSha) {
      return false
    }
    return entry.state === 'failed' && entry.effect !== 'none' && entry.effect !== 'committed'
  })
}

export function getInFlightActions(
  ledger: HostedReviewSitterLedger,
  headSha?: string
): readonly ActionLedgerEntry[] {
  return getLatestActionTransitions(ledger).filter((entry) => {
    if (headSha && entry.action.headSha !== headSha) {
      return false
    }
    return entry.state === 'attempted' || entry.state === 'running'
  })
}

export function getLatestDiscrepancies(
  ledger: HostedReviewSitterLedger
): ReadonlyMap<string, DiscrepancyLedgerEntry> {
  const latest = new Map<string, DiscrepancyLedgerEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'discrepancy') {
      continue
    }
    const previous = latest.get(entry.discrepancyId)
    if (!previous || entry.atMs >= previous.atMs) {
      latest.set(entry.discrepancyId, entry)
    }
  }
  return latest
}

export function hasRecordedLifecycle(
  ledger: HostedReviewSitterLedger,
  state: 'merged' | 'closed'
): boolean {
  return ledger.entries.some((entry) => entry.kind === 'lifecycle' && entry.state === state)
}

/**
 * Sums only completed service-observed checkpoints. Callers must append
 * checkpoints while the service is alive and must never synthesize the time
 * between the last checkpoint and a later process launch.
 */
export function getActiveTimeMs(ledger: HostedReviewSitterLedger): number {
  let total = 0
  for (const entry of ledger.entries) {
    if (entry.kind === 'active-time') {
      total += Math.max(0, entry.activeMs)
    }
  }
  return total
}

export function getRemainingBudgetMs(ledger: HostedReviewSitterLedger, budgetMs: number): number {
  return Math.max(0, budgetMs - getActiveTimeMs(ledger))
}
