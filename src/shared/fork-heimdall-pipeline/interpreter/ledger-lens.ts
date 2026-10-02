import { makeAttemptFingerprint } from '../../fork-heimdall/attempt-fingerprint'
import type {
  ApprovalEntry,
  AttemptEntry,
  EscalationEntry,
  KernelAction,
  LedgerEntry,
  WatcherLedger
} from '../../fork-heimdall/ledger-types'
import { makePipelineNodeEvidenceKey, parsePipelineNodeEvidenceKey } from '../choice-types'
import { nodeIdFromInstanceId, pipelineNodeIdentity } from './node-instance'

function evidenceBelongsToNode(payload: unknown, instanceId: string, epoch: number): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }
  if ('scope' in payload && payload.scope !== null && typeof payload.scope === 'object') {
    if ('evidenceKey' in payload.scope && typeof payload.scope.evidenceKey === 'string') {
      const parsed = parsePipelineNodeEvidenceKey(payload.scope.evidenceKey)
      return parsed?.instanceId === instanceId && parsed.epoch === epoch
    }
  }
  const matches =
    ('instanceId' in payload && payload.instanceId === instanceId) ||
    ('nodeInstanceId' in payload && payload.nodeInstanceId === instanceId) ||
    ('loopId' in payload && payload.loopId === instanceId) ||
    ('mergeId' in payload && payload.mergeId === instanceId)
  if (matches) {
    return 'epoch' in payload && typeof payload.epoch === 'number' ? payload.epoch === epoch : true
  }
  return false
}

function approvalBelongsToNode(
  entry: ApprovalEntry | EscalationEntry,
  instanceId: string,
  epoch: number
): boolean {
  const scope = 'scope' in entry ? entry.scope : entry.approvalScope
  if (scope !== undefined) {
    const parsed = parsePipelineNodeEvidenceKey(scope.evidenceKey)
    return parsed?.instanceId === instanceId && parsed.epoch === epoch
  }
  if ('scope' in entry || entry.escalationKind !== 'owner-deviation') {
    return false
  }
  const naturalKey = `pipeline-node:${encodeURIComponent(instanceId)}:${encodeURIComponent(String(epoch))}:`
  return entry.escalationId.includes(naturalKey)
}

/** Wraps a composite's native action without changing its own identity. */
export function wrapCompositeAction(
  instanceId: string,
  epoch: number,
  sub: KernelAction,
  runContentIdentity: string
): KernelAction {
  const previous = pipelineNodeIdentity(sub)
  const attempt = previous?.attempt ?? 0
  const nodeId = nodeIdFromInstanceId(instanceId)
  return {
    ...sub,
    contentIdentity: runContentIdentity,
    evidenceKey: makePipelineNodeEvidenceKey({
      instanceId,
      epoch,
      attempt,
      innerContentIdentity: sub.contentIdentity,
      innerEvidenceKey: sub.evidenceKey
    }),
    pipelineNode: {
      instanceId,
      nodeId,
      epoch,
      attempt,
      inner: { contentIdentity: sub.contentIdentity, evidenceKey: sub.evidenceKey }
    }
  }
}

/** Restores a wrapped action's native identity; returns null for any other node action. */
export function unwrapCompositeAction(action: KernelAction): KernelAction | null {
  const identity = pipelineNodeIdentity(action)
  if (identity?.inner === undefined) {
    return null
  }
  const unwrapped = { ...action }
  delete unwrapped.pipelineNode
  unwrapped.contentIdentity = identity.inner.contentIdentity
  unwrapped.evidenceKey = identity.inner.evidenceKey
  return unwrapped
}

/** Restricts the run ledger to one composite node and restores inner fingerprints. */
export function scopeLedgerForNode(
  ledger: WatcherLedger,
  instanceId: string,
  epoch: number
): WatcherLedger {
  const attempts = new Map<string, AttemptEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'attempt') {
      continue
    }
    const identity = pipelineNodeIdentity(entry.action)
    if (identity?.instanceId !== instanceId || identity.epoch !== epoch) {
      continue
    }
    const action = unwrapCompositeAction(entry.action)
    if (action === null) {
      continue
    }
    attempts.set(entry.attemptId, {
      ...entry,
      action,
      fingerprint: makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
    })
  }

  const scopedAttemptIds = new Set(attempts.keys())
  const appendedAttempts = new Set<string>()
  const entries: LedgerEntry[] = []
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt') {
      const attempt = attempts.get(entry.attemptId)
      if (attempt !== undefined && !appendedAttempts.has(entry.attemptId)) {
        appendedAttempts.add(entry.attemptId)
        entries.push(attempt)
      }
    } else if (entry.kind === 'attempt-resolved' && scopedAttemptIds.has(entry.attemptId)) {
      entries.push(entry)
    } else if (entry.kind === 'approval' && approvalBelongsToNode(entry, instanceId, epoch)) {
      entries.push(entry)
    } else if (entry.kind === 'escalation' && approvalBelongsToNode(entry, instanceId, epoch)) {
      entries.push(entry)
    } else if (
      entry.kind === 'evidence' &&
      (evidenceBelongsToNode(entry.payload, instanceId, epoch) ||
        entry.evidenceKind === 'fix-attribution')
    ) {
      entries.push(entry)
    }
  }
  return { watcherId: ledger.watcherId, entries }
}
