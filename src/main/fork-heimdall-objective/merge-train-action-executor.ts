import type { ActionOutcome, EffectCertainty } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext, LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  objectiveActionNaturalKey,
  type ApplyNodeAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import {
  computeWorkspaceContentIdentity,
  isObjectiveMetadataPath,
  objectiveGitCommandForTarget,
  type ObjectiveWorkspaceTarget
} from './content-identity'
import {
  findObjectiveWorkerEvidence,
  objectiveResultDigest,
  type ObjectiveSnapshotBinding
} from './execution-context'
import {
  applyObjectiveNodeCommit,
  recoverObjectiveNodeApply,
  type ObjectiveNodeRecoveryResult
} from './merge-train-git'
import type { ObjectiveStore } from './objective-store'

const TRAIN_NOTE_MAX_CHARS = 2_048
const TRAIN_PAUSED_NOTE_PREFIX = 'Merge train paused by operator edits:'

function pausedNote(paths: readonly string[], pathCount: number): string {
  const suffix = pathCount > paths.length ? ` and ${pathCount - paths.length} more` : ''
  const value = `${TRAIN_PAUSED_NOTE_PREFIX} ${paths.join(', ')}${suffix}`
  return value.length <= TRAIN_NOTE_MAX_CHARS
    ? value
    : `${value.slice(0, TRAIN_NOTE_MAX_CHARS - 1)}…`
}

async function commitPaths(
  target: ObjectiveWorkspaceTarget,
  commitSha: string
): Promise<Set<string>> {
  const stdout = (
    await objectiveGitCommandForTarget(target)([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      `${commitSha}^`,
      commitSha
    ])
  ).stdout
  return new Set(
    stdout.split('\0').filter((path) => path.length > 0 && !isObjectiveMetadataPath(path))
  )
}

function gitExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }
  const code = error.code
  return typeof code === 'number'
    ? code
    : typeof code === 'string' && /^\d+$/u.test(code)
      ? Number(code)
      : null
}

async function commitIsAfterBaseline(
  target: ObjectiveWorkspaceTarget,
  commitSha: string,
  baseCommit: string
): Promise<boolean> {
  try {
    await objectiveGitCommandForTarget(target)([
      'merge-base',
      '--is-ancestor',
      commitSha,
      baseCommit
    ])
    return false
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return true
    }
    throw error
  }
}

async function conflictingAppliedDispatches(args: {
  target: ObjectiveWorkspaceTarget
  record: ObjectiveDispatchRecord
  dispatches: readonly ObjectiveDispatchRecord[]
  conflictPaths: readonly string[]
}): Promise<ObjectiveDispatchRecord[]> {
  const conflicts = new Set(args.conflictPaths)
  const matches: ObjectiveDispatchRecord[] = []
  for (const candidate of args.dispatches) {
    if (
      candidate.state !== 'applied' ||
      candidate.appliedCommitSha === null ||
      candidate.dispatchId === null ||
      candidate.revisionId !== args.record.revisionId ||
      candidate.taskKey === args.record.taskKey ||
      !(await commitIsAfterBaseline(
        args.target,
        candidate.appliedCommitSha,
        args.record.baseCommit
      ))
    ) {
      continue
    }
    const paths = await commitPaths(args.target, candidate.appliedCommitSha)
    if ([...paths].some((path) => conflicts.has(path))) {
      matches.push(candidate)
    }
  }
  return matches
}

function currentTaskMatches(
  record: ObjectiveDispatchRecord,
  objectiveStore: ObjectiveStore
): boolean {
  const currentTask = objectiveStore.getTask(record.revisionId, record.taskKey)
  return currentTask !== null && objectiveResultDigest(currentTask) === record.planTaskDigest
}

async function discardObsoleteDispatch(args: {
  record: ObjectiveDispatchRecord
  lease: LeaseGuard
  objectiveStore: ObjectiveStore
}): Promise<void> {
  await args.lease.assertHeld()
  args.objectiveStore.saveDispatch({
    ...args.record,
    state: 'discarded',
    setupState: 'retained',
    completedAtMs: args.record.completedAtMs ?? Date.now()
  })
}

function workerEvidence(args: { record: ObjectiveDispatchRecord; ledger: WatcherLedger }): {
  orchestrationTaskId: string
  atMs: number
} {
  if (args.record.dispatchId === null) {
    throw new Error('Queued objective dispatch has no dispatch id')
  }
  const evidence = findObjectiveWorkerEvidence(args.ledger, args.record.dispatchId)
  if (evidence?.orchestrationTaskId === null || evidence?.orchestrationTaskId === undefined) {
    throw new Error('Queued objective dispatch has no orchestration task id')
  }
  return { orchestrationTaskId: evidence.orchestrationTaskId, atMs: evidence.atMs }
}

async function finalizeAppliedDispatch(args: {
  record: ObjectiveDispatchRecord
  appliedCommitSha: string
  ledger: WatcherLedger
  lease: LeaseGuard
  objectiveStore: ObjectiveStore
}): Promise<ObjectiveDispatchRecord> {
  await args.lease.assertHeld()
  const applied: ObjectiveDispatchRecord = {
    ...args.record,
    state: 'applied',
    appliedCommitSha: args.appliedCommitSha,
    setupState: args.record.conflictPaths.length > 0 ? 'retained' : args.record.setupState,
    completedAtMs: args.record.completedAtMs ?? Date.now()
  }
  args.objectiveStore.saveDispatch(applied)
  if (currentTaskMatches(applied, args.objectiveStore)) {
    const evidence = workerEvidence(args)
    args.objectiveStore.recordNodeDispatch({
      watcherId: applied.watcherId,
      revisionId: applied.revisionId,
      taskKey: applied.taskKey,
      orchestrationTaskId: evidence.orchestrationTaskId,
      dispatchId: applied.dispatchId!,
      dispatchedAtMs: evidence.atMs
    })
  }
  args.objectiveStore.clearParallelNoteWithPrefix(applied.watcherId, TRAIN_PAUSED_NOTE_PREFIX)
  return args.objectiveStore.getDispatch(applied.attemptFingerprint) ?? applied
}

async function persistNonAppliedResult(args: {
  result: Exclude<ObjectiveNodeRecoveryResult, { kind: 'applied' }>
  record: ObjectiveDispatchRecord
  binding: ObjectiveSnapshotBinding
  lease: LeaseGuard
  objectiveStore: ObjectiveStore
}): Promise<void> {
  await args.lease.assertHeld()
  if (args.result.kind === 'paused-dirty') {
    args.objectiveStore.saveDispatch({ ...args.record, state: 'waiting-to-apply' })
    args.objectiveStore.setParallelNote(
      args.record.watcherId,
      pausedNote(args.result.paths, args.result.pathCount)
    )
    return
  }
  if (args.result.kind === 'not-applied') {
    await discardObsoleteDispatch(args)
    return
  }
  const conflictingDispatches = await conflictingAppliedDispatches({
    target: args.binding.target,
    record: args.record,
    dispatches: args.objectiveStore.listDispatches(args.record.watcherId),
    conflictPaths: args.result.allConflictPaths
  })
  if (conflictingDispatches.length === 0) {
    throw new Error('Objective node conflict could not be attributed to an applied dispatch')
  }
  await args.lease.assertHeld()
  args.objectiveStore.saveDispatch({
    ...args.record,
    state: 'resolving-conflict',
    setupState: 'retained',
    conflictPaths: args.result.paths,
    conflictingTaskKeys: [...new Set(conflictingDispatches.map((record) => record.taskKey))],
    conflictingDispatchIds: conflictingDispatches.map((record) => record.dispatchId!)
  })
  args.objectiveStore.clearParallelNoteWithPrefix(args.record.watcherId, TRAIN_PAUSED_NOTE_PREFIX)
}

export async function executeObjectiveApplyNode(args: {
  action: ApplyNodeAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const record = args.objectiveStore.dispatchForId(
    args.binding.enrollment.watcherId,
    args.action.dispatchId
  )
  if (
    !record ||
    record.revisionId !== args.action.revisionId ||
    record.taskKey !== args.action.taskKey ||
    record.commitSha === null
  ) {
    return { effect: 'not-landed', reason: 'objective-dispatch-not-queued' }
  }
  if (record.state === 'applied' && record.appliedCommitSha !== null) {
    await finalizeAppliedDispatch({
      record,
      appliedCommitSha: record.appliedCommitSha,
      ledger: args.context.ledger,
      lease: args.context.lease,
      objectiveStore: args.objectiveStore
    })
    return {
      effect: 'landed',
      result: {
        kind: 'node-applied',
        naturalKey: objectiveActionNaturalKey(args.action),
        digest: objectiveResultDigest(record.appliedCommitSha),
        commitSha: record.appliedCommitSha
      }
    }
  }
  if (record.state !== 'waiting-to-apply' && record.state !== 'applying') {
    return { effect: 'not-landed', reason: `objective-dispatch-${record.state}` }
  }
  const taskMatches = currentTaskMatches(record, args.objectiveStore)
  if (record.state === 'waiting-to-apply' && !taskMatches) {
    await discardObsoleteDispatch({
      record,
      lease: args.context.lease,
      objectiveStore: args.objectiveStore
    })
    return { effect: 'not-landed', reason: 'objective-dispatch-obsolete' }
  }
  if (taskMatches) {
    try {
      workerEvidence({ record, ledger: args.context.ledger })
    } catch (error) {
      return {
        effect: 'not-landed',
        failureClass: 'infra',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }
  await args.context.lease.assertHeld()
  if (record.state === 'waiting-to-apply') {
    const currentIdentity = await computeWorkspaceContentIdentity(args.binding.target)
    await args.context.lease.assertHeld()
    if (
      currentIdentity !== args.action.contentIdentity ||
      currentIdentity !== args.context.snapshot.contentIdentity
    ) {
      return { effect: 'not-landed', reason: 'objective-apply-snapshot-stale' }
    }
  }
  const applying = { ...record, state: 'applying' as const }
  await args.context.lease.assertHeld()
  args.objectiveStore.saveDispatch(applying)
  const result =
    record.state === 'applying'
      ? await recoverObjectiveNodeApply(
          args.binding.target,
          record.commitSha,
          args.context.lease,
          taskMatches ? {} : { retry: false }
        )
      : await applyObjectiveNodeCommit(args.binding.target, record.commitSha, args.context.lease)
  if (result.kind !== 'applied') {
    await persistNonAppliedResult({
      result,
      record: applying,
      binding: args.binding,
      lease: args.context.lease,
      objectiveStore: args.objectiveStore
    })
    const boundedResult =
      result.kind === 'conflict'
        ? {
            kind: result.kind,
            paths: result.paths,
            pathCount: result.pathCount,
            pathsTruncated: result.pathsTruncated
          }
        : result
    return {
      effect: 'not-landed',
      ...(result.kind === 'conflict' ? { failureClass: 'criteria' as const } : {}),
      reason:
        result.kind === 'conflict'
          ? 'objective-node-apply-conflict'
          : result.kind === 'not-applied'
            ? 'objective-dispatch-obsolete'
            : 'objective-train-paused',
      result: boundedResult
    }
  }
  const applied = await finalizeAppliedDispatch({
    record: applying,
    appliedCommitSha: result.appliedCommitSha,
    ledger: args.context.ledger,
    lease: args.context.lease,
    objectiveStore: args.objectiveStore
  })
  return {
    effect: 'landed',
    result: {
      kind: 'node-applied',
      naturalKey: objectiveActionNaturalKey(args.action),
      digest: objectiveResultDigest(applied),
      commitSha: result.appliedCommitSha
    }
  }
}

export async function recoverObjectiveApplyNode(args: {
  action: ApplyNodeAction
  binding: ObjectiveSnapshotBinding
  ledger: WatcherLedger
  lease: LeaseGuard
  objectiveStore: ObjectiveStore
}): Promise<EffectCertainty> {
  const record = args.objectiveStore.dispatchForId(
    args.binding.enrollment.watcherId,
    args.action.dispatchId
  )
  if (!record || record.commitSha === null) {
    return 'not-landed'
  }
  if (record.state === 'applied' && record.appliedCommitSha !== null) {
    await finalizeAppliedDispatch({ ...args, record, appliedCommitSha: record.appliedCommitSha })
    return 'landed'
  }
  if (record.state !== 'applying') {
    return 'not-landed'
  }
  const taskMatches = currentTaskMatches(record, args.objectiveStore)
  const result = await recoverObjectiveNodeApply(
    args.binding.target,
    record.commitSha,
    args.lease,
    taskMatches ? {} : { retry: false }
  )
  if (result.kind !== 'applied') {
    await persistNonAppliedResult({
      result,
      record,
      binding: args.binding,
      lease: args.lease,
      objectiveStore: args.objectiveStore
    })
    return 'not-landed'
  }
  await finalizeAppliedDispatch({
    record,
    appliedCommitSha: result.appliedCommitSha,
    ledger: args.ledger,
    lease: args.lease,
    objectiveStore: args.objectiveStore
  })
  return 'landed'
}
