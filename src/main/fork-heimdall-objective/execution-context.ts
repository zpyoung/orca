import { createHash } from 'node:crypto'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import {
  ObjectivePendingReportSchema,
  type ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveWorkspaceTarget } from './content-identity'

export type ObjectiveSnapshotBinding = {
  enrollment: WatcherEnrollment
  contract: ObjectiveEnrollmentPayload
  target: ObjectiveWorkspaceTarget
}

export type ObjectiveDispatchAttempt = {
  attempt: AttemptEntry
  action: Extract<ObjectiveAction, { kind: `dispatch-${string}` }>
}

export type ObjectiveWorkerEvidence = {
  dispatchId: string
  outcome: 'succeeded' | 'failed'
  reportPath: string | null
  filesModified: string[]
  filesModifiedValid: boolean
  reportRejection: { code: string; reason: string } | null
  reportRejectionValid: boolean
  orchestrationTaskId: string | null
  atMs: number
}

export function objectiveResultDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function bindObjectiveSnapshot(
  bindings: WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>,
  snapshot: Snapshot<ObjectiveWorld>,
  binding: ObjectiveSnapshotBinding
): Snapshot<ObjectiveWorld> {
  bindings.set(snapshot, binding)
  return snapshot
}

export function requireObjectiveSnapshotBinding(
  bindings: WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>,
  snapshot: Snapshot<ObjectiveWorld>
): ObjectiveSnapshotBinding {
  const binding = bindings.get(snapshot)
  if (!binding) {
    throw new Error('Objective snapshot execution context is unavailable')
  }
  return binding
}

export function findObjectiveDispatchAttempt(
  ledger: WatcherLedger,
  dispatchId: string
): ObjectiveDispatchAttempt | null {
  for (const attempt of getLatestAttempts(ledger)) {
    if (attempt.dispatchId !== dispatchId) {
      continue
    }
    const parsed = ObjectiveActionSchema.safeParse(attempt.action)
    if (!parsed.success || !parsed.data.kind.startsWith('dispatch-')) {
      continue
    }
    return {
      attempt,
      action: parsed.data as ObjectiveDispatchAttempt['action']
    }
  }
  return null
}

function mailboxRecord(value: unknown): {
  type: string
  payload: Record<string, unknown>
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const message = value as Record<string, unknown>
  if (
    typeof message.type !== 'string' ||
    typeof message.payload !== 'object' ||
    message.payload === null ||
    Array.isArray(message.payload)
  ) {
    return null
  }
  return { type: message.type, payload: message.payload as Record<string, unknown> }
}

function reportRejection(value: unknown): {
  value: { code: string; reason: string } | null
  valid: boolean
} {
  if (value === undefined) {
    return { value: null, valid: true }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value: null, valid: false }
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.code !== 'string' ||
    record.code.trim().length === 0 ||
    typeof record.reason !== 'string' ||
    record.reason.trim().length === 0
  ) {
    return { value: null, valid: false }
  }
  return { value: { code: record.code, reason: record.reason }, valid: true }
}

export function findObjectiveWorkerEvidence(
  ledger: WatcherLedger,
  dispatchId: string
): ObjectiveWorkerEvidence | null {
  let firstTaskId: string | null = null
  let found: Omit<ObjectiveWorkerEvidence, 'orchestrationTaskId'> | null = null
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== 'orchestration-mailbox') {
      continue
    }
    const message = mailboxRecord(entry.payload)
    const payload = message?.payload
    if (payload?.dispatchId !== dispatchId) {
      continue
    }
    if (firstTaskId === null && typeof payload.taskId === 'string') {
      firstTaskId = payload.taskId
    }
    if (
      message?.type !== 'worker_done' ||
      (payload.outcome !== 'succeeded' && payload.outcome !== 'failed')
    ) {
      continue
    }
    const parsedFiles = Object.hasOwn(payload, 'filesModified')
      ? ObjectivePendingReportSchema.shape.filesModified.safeParse(payload.filesModified)
      : null
    const parsedRejection = reportRejection(payload.reportRejection)
    found = {
      dispatchId,
      outcome: payload.outcome,
      reportPath: typeof payload.reportPath === 'string' ? payload.reportPath : null,
      filesModified: parsedFiles?.success ? parsedFiles.data : [],
      filesModifiedValid: parsedFiles === null || parsedFiles.success,
      reportRejection: parsedRejection.value,
      reportRejectionValid: parsedRejection.valid,
      atMs: entry.atMs
    }
  }
  return found ? { ...found, orchestrationTaskId: firstTaskId } : null
}
