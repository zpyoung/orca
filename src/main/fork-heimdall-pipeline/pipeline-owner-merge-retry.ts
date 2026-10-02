import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { KernelAction, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PipelineNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  childTaskIdFromInstanceId,
  nodeIdFromInstanceId
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { pipelineNodeIdentity } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter/run-state'
import { pipelineAttemptFacts } from '../../shared/fork-heimdall-pipeline/interpreter/node-history'
import type { PipelineAttemptFact } from '../../shared/fork-heimdall-pipeline/interpreter/node-history'
import { parsePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { PipelineReadyWorld } from './pipeline-kind-read'

type MergeOrigin = Readonly<{
  originalMergeStep: string
  originalMergeEpoch: number
  originalMergeAttemptId: string
  originalMergeAttemptFingerprint: string
}>

export type PipelineMergeRetryProgressPlan = Readonly<{
  nextEpoch: number
  rows: readonly PipelineStoreFacts['mergeProgress'][number][]
}>

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function originFromRetryAction(action: KernelAction): MergeOrigin | null {
  const step = action.originalMergeStep
  const epoch = action.originalMergeEpoch
  const attemptId = action.originalMergeAttemptId
  const fingerprint = action.originalMergeAttemptFingerprint
  return typeof step === 'string' &&
    typeof epoch === 'number' &&
    Number.isInteger(epoch) &&
    epoch >= 0 &&
    typeof attemptId === 'string' &&
    typeof fingerprint === 'string'
    ? {
        originalMergeStep: step,
        originalMergeEpoch: epoch,
        originalMergeAttemptId: attemptId,
        originalMergeAttemptFingerprint: fingerprint
      }
    : null
}

function conflictResultMatches(
  fact: PipelineAttemptFact,
  row: PipelineStoreFacts['mergeProgress'][number],
  origin: MergeOrigin
): boolean {
  const action = fact.entry.action
  const result = fact.entry.result
  return (
    row.commitSha !== null &&
    row.conflict !== null &&
    action.kind === 'pipeline-merge-child' &&
    action.capability === 'integrate' &&
    fact.identity.instanceId === row.mergeId &&
    fact.identity.nodeId === row.mergeId &&
    fact.identity.epoch === origin.originalMergeEpoch &&
    fact.entry.attemptId === origin.originalMergeAttemptId &&
    fact.entry.state === 'settled' &&
    fact.effect === 'not-landed' &&
    fact.entry.reason === 'merge-conflict' &&
    fact.entry.fingerprint === origin.originalMergeAttemptFingerprint &&
    fact.entry.fingerprint ===
      makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey) &&
    action.mergeId === row.mergeId &&
    action.childInstanceId === row.childInstanceId &&
    parsePipelineNodeEvidenceKey(action.evidenceKey)?.step === origin.originalMergeStep &&
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    'conflictPaths' in result &&
    Array.isArray(result.conflictPaths) &&
    result.conflictPaths.every((path) => typeof path === 'string') &&
    'conflictingChildren' in result &&
    Array.isArray(result.conflictingChildren) &&
    result.conflictingChildren.every((child) => typeof child === 'string') &&
    sameStrings(result.conflictPaths, row.conflict.paths) &&
    sameStrings(result.conflictingChildren, row.conflict.conflictingChildren)
  )
}

function conflictAttemptFields(
  ledger: WatcherLedger,
  row: PipelineStoreFacts['mergeProgress'][number]
): MergeOrigin | null {
  const attempts = pipelineAttemptFacts(ledger)
  let selectedRetry: { fact: PipelineAttemptFact; origin: MergeOrigin } | null = null
  for (const fact of attempts) {
    const action = fact.entry.action
    const origin = originFromRetryAction(action)
    if (
      action.kind !== 'pipeline-apply-choice' ||
      action.cause !== 'merge-conflict' ||
      action.choice !== 'retry' ||
      action.conflictingChildInstanceId !== row.childInstanceId ||
      fact.identity.instanceId !== row.mergeId ||
      fact.identity.nodeId !== row.mergeId ||
      fact.identity.epoch >= row.epoch ||
      fact.entry.state !== 'settled' ||
      fact.effect !== 'landed' ||
      origin === null
    ) {
      continue
    }
    const original = attempts.find(
      (candidate) => candidate.entry.attemptId === origin.originalMergeAttemptId
    )
    if (
      original === undefined ||
      !conflictResultMatches(original, row, origin) ||
      (selectedRetry !== null && selectedRetry.fact.entry.atMs >= fact.entry.atMs)
    ) {
      continue
    }
    selectedRetry = { fact, origin }
  }
  if (selectedRetry !== null) {
    return selectedRetry.origin
  }

  let selected: PipelineAttemptFact | null = null
  for (const fact of attempts) {
    const step = parsePipelineNodeEvidenceKey(fact.entry.action.evidenceKey)?.step
    if (
      fact.identity.epoch !== row.epoch ||
      typeof step !== 'string' ||
      (selected !== null && selected.entry.atMs >= fact.entry.atMs)
    ) {
      continue
    }
    const origin: MergeOrigin = {
      originalMergeStep: step,
      originalMergeEpoch: fact.identity.epoch,
      originalMergeAttemptId: fact.entry.attemptId,
      originalMergeAttemptFingerprint: fact.entry.fingerprint
    }
    if (conflictResultMatches(fact, row, origin)) {
      selected = fact
    }
  }
  if (selected === null) {
    return null
  }
  const step = parsePipelineNodeEvidenceKey(selected.entry.action.evidenceKey)?.step
  if (step === undefined) {
    return null
  }
  return {
    originalMergeStep: step,
    originalMergeEpoch: selected.identity.epoch,
    originalMergeAttemptId: selected.entry.attemptId,
    originalMergeAttemptFingerprint: selected.entry.fingerprint
  }
}

export function mergeRetryProvenanceFields(
  ledger: WatcherLedger,
  row: PipelineStoreFacts['mergeProgress'][number]
): Readonly<Record<string, unknown>> | null {
  return conflictAttemptFields(ledger, row)
}

export function mergeRetryProvenanceMatches(
  action: KernelAction,
  ledger: WatcherLedger,
  row: PipelineStoreFacts['mergeProgress'][number]
): boolean {
  const fields = conflictAttemptFields(ledger, row)
  const paths = action.conflictPaths
  const children = action.conflictingChildren
  return (
    fields !== null &&
    row.conflict !== null &&
    row.commitSha !== null &&
    action.conflictingChildInstanceId === row.childInstanceId &&
    Array.isArray(paths) &&
    paths.every((path) => typeof path === 'string') &&
    sameStrings(paths, row.conflict.paths) &&
    Array.isArray(children) &&
    children.every((child) => typeof child === 'string') &&
    sameStrings(children, row.conflict.conflictingChildren) &&
    action.originalMergeStep === fields.originalMergeStep &&
    action.originalMergeEpoch === fields.originalMergeEpoch &&
    action.originalMergeAttemptId === fields.originalMergeAttemptId &&
    action.originalMergeAttemptFingerprint === fields.originalMergeAttemptFingerprint
  )
}

export function pipelineMergeConflictChild(
  action: KernelAction,
  mergeId: string,
  node: PipelineNode
): string {
  const childInstanceId = action.conflictingChildInstanceId
  if (
    node.type !== 'merge' ||
    typeof childInstanceId !== 'string' ||
    childTaskIdFromInstanceId(childInstanceId) === null ||
    nodeIdFromInstanceId(childInstanceId) !== node.from ||
    (action.mergeId !== undefined && mergeId !== action.mergeId)
  ) {
    throw new Error('Merge choice does not identify its current conflicting child')
  }
  return childInstanceId
}

export function pipelineMergeRetryProgressPlan(
  world: PipelineReadyWorld,
  ledger: WatcherLedger,
  action: KernelAction,
  mergeId: string,
  node: PipelineNode
): PipelineMergeRetryProgressPlan {
  const conflictChild = pipelineMergeConflictChild(action, mergeId, node)
  const identity = pipelineNodeIdentity(action)
  if (
    identity === null ||
    identity.inner !== undefined ||
    identity.instanceId !== mergeId ||
    identity.nodeId !== mergeId
  ) {
    throw new Error('Merge retry action has an invalid node identity')
  }
  const currentEpoch =
    derivePipelineRunState({
      payload: world.payload,
      ledger,
      facts: world.facts,
      nowMs: world.nowMs,
      hasOwner: world.hasOwner,
      unverifiableDispatchIds: world.unverifiableDispatchIds,
      composites: world.composites
    }).nodes.get(mergeId)?.epoch ?? identity.epoch
  const nextEpoch = Math.max(currentEpoch, identity.epoch) + 1
  const conflictRow = world.facts.mergeProgress.find(
    (row) =>
      row.mergeId === mergeId &&
      row.epoch === identity.epoch &&
      row.childInstanceId === conflictChild &&
      (row.state === 'conflict' || row.state === 'resolving' || row.state === 'resolved')
  )
  if (
    conflictRow === undefined ||
    conflictRow.commitSha === null ||
    conflictRow.conflict === null ||
    !mergeRetryProvenanceMatches(action, ledger, conflictRow)
  ) {
    throw new Error('Merge retry does not carry the exact original conflict attempt')
  }
  const rows: PipelineStoreFacts['mergeProgress'] = []
  for (const row of world.facts.mergeProgress) {
    if (row.mergeId !== mergeId || row.epoch !== identity.epoch) {
      continue
    }
    if (row.state === 'applied' || row.state === 'skipped') {
      rows.push({ ...row, epoch: nextEpoch })
    } else if (
      row.childInstanceId === conflictChild &&
      (row.state === 'conflict' || row.state === 'resolving' || row.state === 'resolved')
    ) {
      rows.push({ ...row, epoch: nextEpoch, state: 'conflict' })
    }
  }
  return { nextEpoch, rows }
}

export function pipelineMergeRetryProgressPersisted(
  world: PipelineReadyWorld,
  plan: PipelineMergeRetryProgressPlan
): boolean {
  return (
    plan.rows.length > 0 &&
    plan.rows.every((expected) => {
      const actual = world.facts.mergeProgress.find(
        (row) =>
          row.mergeId === expected.mergeId &&
          row.epoch === plan.nextEpoch &&
          row.childInstanceId === expected.childInstanceId
      )
      return (
        actual !== undefined &&
        actual.state === expected.state &&
        actual.commitSha === expected.commitSha &&
        actual.appliedCommitSha === expected.appliedCommitSha &&
        (actual.conflict === null || expected.conflict === null
          ? actual.conflict === expected.conflict
          : sameStrings(actual.conflict.paths, expected.conflict.paths) &&
            sameStrings(actual.conflict.conflictingChildren, expected.conflict.conflictingChildren))
      )
    })
  )
}
