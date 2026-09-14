import { z } from 'zod'
import { inspectAttemptLedger, makeAttemptFingerprint } from './attempt-fingerprint'
import { deriveBudgetState } from './budget'
import { getLatestApproval, getLatestEscalation, sameApprovalScope } from './ledger-queries'
import {
  ApprovalScopeSchema,
  type ApprovalScope,
  type KernelAction,
  type WatcherLedger
} from './ledger-types'
import type { Snapshot } from './snapshot'
import { CapabilityModeSchema, type WatcherEnrollment } from './watcher-types'

export { ApprovalScopeSchema, CapabilityModeSchema }
export type { ApprovalScope }
export type CapabilityMode = z.infer<typeof CapabilityModeSchema>

export const GateEscalationRevisionSchema = z
  .object({
    escalationId: z.string().min(1),
    escalationKind: z.literal('awaiting-approval'),
    foldCount: z.number().int().positive(),
    approvalScope: ApprovalScopeSchema
  })
  .strict()
export type GateEscalationRevision = z.infer<typeof GateEscalationRevisionSchema>

export const GateVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('allow') }).strict(),
  z
    .object({
      verdict: z.literal('hold'),
      reason: z.string().min(1),
      escalation: GateEscalationRevisionSchema.optional()
    })
    .strict(),
  z.object({ verdict: z.literal('escalate'), reason: z.string().min(1) }).strict()
])
export type GateVerdict = z.infer<typeof GateVerdictSchema>

export type GateEnrollment = Pick<WatcherEnrollment, 'enabled' | 'capabilities' | 'budget'> & {
  parked?: boolean
  stopPredicateFired?: boolean
}

export function approvalScopeForAction(action: KernelAction): ApprovalScope {
  const preparedCommitSha =
    typeof action.preparedCommitSha === 'string' ? action.preparedCommitSha : undefined
  return {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey,
    ...(preparedCommitSha === undefined ? {} : { preparedCommitSha })
  }
}

/**
 * Builds the next append-only approval escalation revision. Equal consecutive holds reuse the
 * logical escalation id and increment its cumulative fold count; no ledger row is updated.
 */
export function deriveAwaitingApprovalRevision(
  ledger: WatcherLedger,
  scope: ApprovalScope
): GateEscalationRevision {
  const latest = getLatestEscalation(ledger)
  if (
    latest?.status === 'open' &&
    latest.escalationKind === 'awaiting-approval' &&
    latest.approvalScope &&
    sameApprovalScope(latest.approvalScope, scope)
  ) {
    return {
      escalationId: latest.escalationId,
      escalationKind: 'awaiting-approval',
      foldCount: latest.foldCount + 1,
      approvalScope: scope
    }
  }
  return {
    escalationId: `awaiting-approval:${ledger.entries.length}:${makeAttemptFingerprint(
      scope.contentIdentity,
      scope.actionKind,
      scope.evidenceKey
    )}`,
    escalationKind: 'awaiting-approval',
    foldCount: 1,
    approvalScope: scope
  }
}

export function gateAction<TWorld>(
  action: KernelAction,
  snapshot: Snapshot<TWorld>,
  enrollment: GateEnrollment,
  ledger: WatcherLedger,
  kindPreflight?: GateVerdict
): GateVerdict {
  if (!enrollment.enabled) {
    return { verdict: 'hold', reason: 'disabled' }
  }
  if (enrollment.parked) {
    return { verdict: 'hold', reason: 'parked' }
  }
  const budget = deriveBudgetState(ledger, enrollment.budget)
  if (budget.exhausted) {
    return { verdict: 'hold', reason: `budget-${budget.exhausted.kind}` }
  }
  if (enrollment.stopPredicateFired) {
    return { verdict: 'hold', reason: 'stop-predicate-fired' }
  }

  const fingerprint = makeAttemptFingerprint(
    action.contentIdentity,
    action.kind,
    action.evidenceKey
  )
  const attempts = inspectAttemptLedger(ledger, fingerprint)
  if (attempts.disposition === 'completed') {
    return { verdict: 'hold', reason: 'attempt-completed' }
  }
  if (attempts.disposition === 'in-flight') {
    return { verdict: 'hold', reason: 'attempt-in-flight' }
  }
  if (attempts.disposition === 'retryable-failure') {
    return { verdict: 'hold', reason: 'retry-needs-new-evidence' }
  }
  if (action.visibility === 'external' && attempts.hasUnresolved) {
    return { verdict: 'hold', reason: 'unresolved-attempt' }
  }
  if (attempts.hasInFlight) {
    return { verdict: 'hold', reason: 'attempt-in-flight' }
  }
  if (action.contentIdentity !== snapshot.contentIdentity) {
    return { verdict: 'hold', reason: 'stale-evidence' }
  }
  if (action.visibility === 'external' && action.expectedState === undefined) {
    return { verdict: 'hold', reason: 'missing-expected-state' }
  }

  const capabilityMode = enrollment.capabilities[action.capability] ?? 'off'
  if (capabilityMode === 'off') {
    return { verdict: 'hold', reason: 'capability-off' }
  }
  if (capabilityMode === 'gated') {
    const scope = approvalScopeForAction(action)
    const approval = getLatestApproval(ledger, scope)
    if (approval?.decision !== 'approved') {
      return {
        verdict: 'hold',
        reason: 'awaiting-approval',
        escalation: deriveAwaitingApprovalRevision(ledger, scope)
      }
    }
  }
  return kindPreflight ?? { verdict: 'allow' }
}
