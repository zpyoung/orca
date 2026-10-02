import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { PipelineMergeNode, PipelineSwarmNode } from '../document-schema'
import type { PipelineStoreFacts } from '../store-facts'
import { parsePipelineNodeEvidenceKey } from '../choice-types'
import { buildPipelineAction } from './action-envelope'
import type { PipelineNodeRunState, PipelineRunState, PipelineWorld } from './index'
import { pipelineAttemptFacts, type PipelineAttemptFact } from './node-history'
import { childTaskIdFromInstanceId, nodeInstanceId } from './node-instance'

type MergeConflictRow = PipelineStoreFacts['mergeProgress'][number]
type AppliedChild = { taskId: string; commitSha: string }

type OriginalMergeAttempt = {
  fact: PipelineAttemptFact
  step: string
  childWorkspacePath: string | null
  childCommitSha: string | null
  originalChildCommitSha: string | null
  originalSourceHead: string
  originalWorkspaceDigest: string
  originalBaseCommit: string
  appliedChildren: AppliedChild[]
}

export type MergeConflictResolution =
  | { status: 'start'; action: KernelAction }
  | { status: 'wait' | 'failed' | 'landed' }

function textField(action: KernelAction, key: string): string | null {
  const value = action[key]
  return typeof value === 'string' ? value : null
}

function nullableTextField(action: KernelAction, key: string): string | null | undefined {
  const value = action[key]
  if (value === null) {
    return null
  }
  return typeof value === 'string' ? value : undefined
}

function appliedChildrenField(action: KernelAction): AppliedChild[] | null {
  const value = action.appliedChildren
  if (!Array.isArray(value)) {
    return null
  }
  const children: AppliedChild[] = []
  for (const row of value) {
    if (
      row === null ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      !('taskId' in row) ||
      !('commitSha' in row) ||
      typeof row.taskId !== 'string' ||
      typeof row.commitSha !== 'string'
    ) {
      return null
    }
    children.push({ taskId: row.taskId, commitSha: row.commitSha })
  }
  return children
}

function optionalTextField(action: KernelAction, key: string): string | undefined {
  const value = action[key]
  return typeof value === 'string' ? value : undefined
}

function recordedChildDispatch(
  ledger: WatcherLedger,
  childInstanceId: string,
  epoch: number,
  attempt: number,
  dispatchId: string
): PipelineAttemptFact | null {
  let latest: PipelineAttemptFact | null = null
  for (const fact of pipelineAttemptFacts(ledger)) {
    if (
      fact.entry.action.kind !== 'pipeline-dispatch-agent' ||
      fact.identity.instanceId !== childInstanceId ||
      fact.identity.epoch !== epoch ||
      fact.identity.attempt !== attempt ||
      fact.entry.state !== 'settled' ||
      fact.effect !== 'landed' ||
      (fact.entry.dispatchId !== undefined && fact.entry.dispatchId !== dispatchId) ||
      (latest !== null && latest.entry.atMs >= fact.entry.atMs)
    ) {
      continue
    }
    latest = fact
  }
  return latest
}

function originalMergeAttempt(
  ledger: WatcherLedger,
  merge: PipelineMergeNode,
  row: MergeConflictRow
): OriginalMergeAttempt | null {
  let latest: OriginalMergeAttempt | null = null
  for (const fact of pipelineAttemptFacts(ledger)) {
    const action = fact.entry.action
    if (
      action.kind !== 'pipeline-merge-child' ||
      fact.identity.instanceId !== merge.id ||
      fact.identity.nodeId !== merge.id ||
      fact.identity.epoch > row.epoch ||
      textField(action, 'mergeId') !== merge.id ||
      textField(action, 'childInstanceId') !== row.childInstanceId ||
      fact.entry.state !== 'settled'
    ) {
      continue
    }
    const step = parsePipelineNodeEvidenceKey(action.evidenceKey)?.step
    const childWorkspacePath = nullableTextField(action, 'childWorkspacePath')
    const originalSourceHead = textField(action, 'sourceHead')
    const originalWorkspaceDigest = textField(action, 'workspaceDigest')
    const originalBaseCommit = textField(action, 'baseCommit')
    const originalChildCommitSha = nullableTextField(action, 'childCommitSha')
    const appliedChildren = appliedChildrenField(action)
    if (
      step === undefined ||
      childWorkspacePath === undefined ||
      originalSourceHead === null ||
      originalWorkspaceDigest === null ||
      originalBaseCommit === null ||
      originalChildCommitSha === undefined ||
      appliedChildren === null ||
      (latest !== null && latest.fact.entry.atMs >= fact.entry.atMs)
    ) {
      continue
    }
    latest = {
      fact,
      step,
      childWorkspacePath,
      childCommitSha: row.commitSha,
      originalChildCommitSha,
      originalSourceHead,
      originalWorkspaceDigest,
      originalBaseCommit,
      appliedChildren
    }
  }
  return latest
}
export function mergeConflictProvenance(
  ledger: WatcherLedger,
  merge: PipelineMergeNode,
  row: MergeConflictRow
): Record<string, unknown> | undefined {
  const original = originalMergeAttempt(ledger, merge, row)
  if (original === null) {
    return undefined
  }
  return {
    originalMergeStep: original.step,
    originalMergeEpoch: original.fact.identity.epoch,
    originalMergeAttemptId: original.fact.entry.attemptId,
    originalMergeAttemptFingerprint: original.fact.entry.fingerprint,
    originalChildCommitSha: original.originalChildCommitSha,
    sourceHead: original.originalSourceHead,
    workspaceDigest: original.originalWorkspaceDigest,
    baseCommit: original.originalBaseCommit,
    childWorkspacePath: original.childWorkspacePath,
    appliedChildren: original.appliedChildren
  }
}

function resolverStep(input: {
  mergeId: string
  row: MergeConflictRow
  original: OriginalMergeAttempt
  currentSourceHead: string
  currentWorkspaceDigest: string
  mergedHead: string
  harness: string
  model?: string
  effort?: string
  workspaceId: string | null
  reuseTerminal: string
}): string {
  const conflict = input.row.conflict
  return JSON.stringify([
    'merge-conflict-resolver',
    input.mergeId,
    input.row.childInstanceId,
    input.original.step,
    input.original.fact.identity.epoch,
    input.original.fact.entry.attemptId,
    input.original.fact.entry.fingerprint,
    input.original.originalChildCommitSha,
    input.original.originalSourceHead,
    input.original.originalWorkspaceDigest,
    input.original.originalBaseCommit,
    input.original.childCommitSha,
    input.currentSourceHead,
    input.currentWorkspaceDigest,
    input.mergedHead,
    input.original.childWorkspacePath,
    conflict?.paths ?? [],
    conflict?.conflictingChildren ?? [],
    input.original.appliedChildren,
    input.harness,
    input.model ?? null,
    input.effort ?? null,
    input.workspaceId,
    input.reuseTerminal
  ])
}

function matchingResolverAttempt(input: {
  ledger: WatcherLedger
  merge: PipelineMergeNode
  row: MergeConflictRow
  state: PipelineNodeRunState
}): PipelineAttemptFact | null {
  const taskId = childTaskIdFromInstanceId(input.row.childInstanceId) ?? ''
  let latest: PipelineAttemptFact | null = null
  for (const fact of pipelineAttemptFacts(input.ledger)) {
    const action = fact.entry.action
    if (
      action.kind !== 'pipeline-resolve-merge-conflict' ||
      fact.identity.instanceId !== nodeInstanceId(input.merge.id, taskId) ||
      fact.identity.nodeId !== input.merge.id ||
      fact.identity.epoch !== input.state.epoch ||
      fact.identity.attempt !== input.state.attempt ||
      textField(action, 'mergeId') !== input.merge.id ||
      textField(action, 'childInstanceId') !== input.row.childInstanceId ||
      (latest !== null && latest.entry.atMs >= fact.entry.atMs)
    ) {
      continue
    }
    latest = fact
  }
  return latest
}

export function mergeConflictResolution(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  merge: PipelineMergeNode
  swarm: PipelineSwarmNode
  row: MergeConflictRow
  state: PipelineNodeRunState
  runState: PipelineRunState
  tasks: PipelineStoreFacts['swarmExpansions'][number]['tasks']
}): MergeConflictResolution {
  const prior = matchingResolverAttempt({
    ledger: input.ledger,
    merge: input.merge,
    row: input.row,
    state: input.state
  })
  if (prior !== null) {
    if (prior.entry.state !== 'settled') {
      return { status: 'wait' }
    }
    return prior.effect === 'landed' ? { status: 'landed' } : { status: 'failed' }
  }
  if (input.row.state === 'resolved') {
    return { status: 'failed' }
  }
  if (input.row.state === 'resolving') {
    return { status: 'wait' }
  }

  const original = originalMergeAttempt(input.ledger, input.merge, input.row)
  if (original === null || original.childCommitSha === null) {
    return { status: 'failed' }
  }

  const taskId = childTaskIdFromInstanceId(input.row.childInstanceId)
  const childState = input.runState.nodes.get(input.row.childInstanceId)
  const source = input.world.mergeSources?.[input.row.childInstanceId]
  let dispatch: PipelineStoreFacts['dispatches'][number] | undefined
  if (taskId !== null && childState !== undefined) {
    for (const candidate of input.world.facts.dispatches) {
      if (
        candidate.instanceId === input.row.childInstanceId &&
        candidate.epoch === childState.epoch &&
        candidate.attempt === childState.attempt &&
        (dispatch === undefined || candidate.dispatchedAtMs > dispatch.dispatchedAtMs)
      ) {
        dispatch = candidate
      }
    }
  }
  const childDispatch =
    dispatch === undefined || childState === undefined
      ? null
      : recordedChildDispatch(
          input.ledger,
          input.row.childInstanceId,
          childState.epoch,
          childState.attempt,
          dispatch.dispatchId
        )
  const recordedAction = childDispatch?.entry.action
  const harness =
    recordedAction === undefined ? undefined : optionalTextField(recordedAction, 'agent')
  const model =
    recordedAction === undefined ? undefined : optionalTextField(recordedAction, 'model')
  const effort =
    recordedAction === undefined ? undefined : optionalTextField(recordedAction, 'effort')
  const expectedModel = input.swarm.child.model ?? input.world.payload.document.defaults?.model
  const expectedEffort = input.swarm.child.effort ?? input.world.payload.document.defaults?.effort
  const task = input.tasks.find((candidate) => candidate.id === taskId)
  const childWorktree =
    childState === undefined
      ? undefined
      : input.world.facts.childWorktrees.find(
          (candidate) =>
            candidate.instanceId === input.row.childInstanceId &&
            candidate.epoch === childState.epoch
        )
  const conflict = input.row.conflict
  if (
    taskId === null ||
    task === undefined ||
    childState?.status !== 'done' ||
    source === undefined ||
    original.childWorkspacePath === null ||
    source.workspacePath === null ||
    source.workspacePath !== original.childWorkspacePath ||
    source.committedChildSha !== input.row.commitSha ||
    source.sourceHead.length === 0 ||
    source.workspaceDigest.length === 0 ||
    source.applicableBaseCommit.length === 0 ||
    dispatch === undefined ||
    dispatch.terminalHandle === null ||
    childWorktree === undefined ||
    childWorktree.setupState !== 'ready' ||
    dispatch.workspaceId !== childWorktree.worktreeId ||
    childDispatch === null ||
    harness === undefined ||
    harness !== input.swarm.child.harness ||
    model !== expectedModel ||
    effort !== expectedEffort ||
    conflict === null ||
    (input.world.grants.agent ?? 'off') === 'off' ||
    (input.world.grants.integrate ?? 'off') === 'off' ||
    input.row.state !== 'conflict'
  ) {
    return { status: 'failed' }
  }

  const nodeInstance = nodeInstanceId(input.merge.id, taskId)
  const step = resolverStep({
    mergeId: input.merge.id,
    row: input.row,
    original,
    currentSourceHead: source.sourceHead,
    currentWorkspaceDigest: source.workspaceDigest,
    mergedHead: source.applicableBaseCommit,
    harness,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    workspaceId: dispatch.workspaceId,
    reuseTerminal: dispatch.terminalHandle
  })
  const action = buildPipelineAction({
    kind: 'pipeline-resolve-merge-conflict',
    capability: 'agent',
    visibility: 'local',
    pin: input.world.payload.pin,
    instanceId: nodeInstance,
    nodeId: input.merge.id,
    epoch: input.state.epoch,
    attempt: input.state.attempt,
    step,
    fields: {
      mergeId: input.merge.id,
      childInstanceId: input.row.childInstanceId,
      taskId,
      childWorkspacePath: original.childWorkspacePath,
      childCommitSha: original.childCommitSha,
      originalChildCommitSha: original.originalChildCommitSha,
      sourceHead: original.originalSourceHead,
      workspaceDigest: original.originalWorkspaceDigest,
      baseCommit: original.originalBaseCommit,
      originalMergeStep: original.step,
      originalMergeEpoch: original.fact.identity.epoch,
      originalMergeAttemptId: original.fact.entry.attemptId,
      originalMergeAttemptFingerprint: original.fact.entry.fingerprint,
      currentSourceHead: source.sourceHead,
      currentWorkspaceDigest: source.workspaceDigest,
      mergedHead: source.applicableBaseCommit,
      conflictPaths: conflict.paths,
      conflictingChildren: conflict.conflictingChildren,
      appliedChildren: original.appliedChildren,
      harness,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      workspaceId: dispatch.workspaceId,
      reuseTerminal: dispatch.terminalHandle
    }
  })
  return { status: 'start', action }
}
