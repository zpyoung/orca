import { getLatestEscalations, sameApprovalScope } from '../../shared/fork-heimdall/ledger-queries'
import type {
  ApprovalScope,
  EscalationEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'

/** A scope can have multiple logical ids when unrelated escalations were appended between holds. */
export function getApprovalEscalationsToResolve(
  ledger: WatcherLedger,
  scope: ApprovalScope
): readonly EscalationEntry[] {
  return getLatestEscalations(ledger).filter(
    (entry) =>
      (entry.status === 'open' || entry.status === 'escalated') &&
      entry.escalationKind === 'awaiting-approval' &&
      entry.approvalScope !== undefined &&
      sameApprovalScope(entry.approvalScope, scope)
  )
}
