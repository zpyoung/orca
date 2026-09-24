import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

const DISPATCH_WORKTREE_MARKER_PREFIX = 'heimdall-objective-dispatch:'
const PENDING_WORKSPACE_PREFIX = 'pending:'

function isPendingWorkspace(record: ObjectiveDispatchRecord): boolean {
  return (
    record.workspaceId.startsWith(PENDING_WORKSPACE_PREFIX) ||
    record.workspacePath.startsWith(PENDING_WORKSPACE_PREFIX)
  )
}

async function removeDispatchWorktree(
  runtime: OrcaRuntimeService,
  record: ObjectiveDispatchRecord
): Promise<void> {
  if (isPendingWorkspace(record)) {
    return
  }
  await runtime.removeManagedWorktree(`id:${record.workspaceId}`, {
    force: true,
    hostId: record.executionHostId
  })
}
function workspaceWorkersReleased(
  objectiveStore: ObjectiveStore,
  record: ObjectiveDispatchRecord,
  workerReleaseConfirmed: (dispatchId: string) => boolean
): boolean {
  const owners = new Map<string, ObjectiveDispatchRecord>()
  for (const candidate of objectiveStore.listDispatches(record.watcherId)) {
    if (candidate.workspaceId !== record.workspaceId || candidate.setupState === 'cleaned') {
      continue
    }
    const incarnation =
      candidate.terminalHandle === null
        ? `dispatch:${candidate.dispatchId ?? candidate.attemptFingerprint}`
        : `terminal:${candidate.terminalHandle}`
    const current = owners.get(incarnation)
    if (
      !current ||
      candidate.sessionNodeCount > current.sessionNodeCount ||
      (candidate.sessionNodeCount === current.sessionNodeCount &&
        candidate.createdAtMs > current.createdAtMs)
    ) {
      owners.set(incarnation, candidate)
    }
  }
  return [...owners.values()].every(
    (owner) => owner.dispatchId !== null && workerReleaseConfirmed(owner.dispatchId)
  )
}

function workspaceMustBeRetained(
  objectiveStore: ObjectiveStore,
  record: ObjectiveDispatchRecord
): boolean {
  return objectiveStore
    .listDispatches(record.watcherId)
    .some(
      (candidate) =>
        candidate.workspaceId === record.workspaceId &&
        (candidate.state === 'failed' || candidate.conflictPaths.length > 0)
    )
}

/** Removes an applied, conflict-free dispatch only after the final node in its lane session. */
export async function cleanupAppliedObjectiveDispatch(args: {
  runtime: OrcaRuntimeService
  objectiveStore: ObjectiveStore
  record: ObjectiveDispatchRecord
  lease: LeaseGuard
  workerReleaseConfirmed: (dispatchId: string) => boolean
}): Promise<void> {
  const laneEnded =
    args.record.laneTaskKeys.at(-1) === args.record.taskKey || args.record.sessionNodeCount >= 5
  if (
    args.record.state !== 'applied' ||
    !laneEnded ||
    args.record.conflictPaths.length > 0 ||
    args.record.setupState === 'cleaned' ||
    workspaceMustBeRetained(args.objectiveStore, args.record) ||
    !workspaceWorkersReleased(args.objectiveStore, args.record, args.workerReleaseConfirmed)
  ) {
    return
  }
  await args.lease.assertHeld()
  const cleanup = { ...args.record, setupState: 'cleanup-pending' as const }
  args.objectiveStore.saveDispatch(cleanup)
  await args.lease.assertHeld()
  await removeDispatchWorktree(args.runtime, cleanup)
  for (const record of args.objectiveStore.listDispatches(args.record.watcherId)) {
    await args.lease.assertHeld()
    if (record.workspaceId === cleanup.workspaceId) {
      args.objectiveStore.saveDispatch({ ...record, setupState: 'cleaned' })
    }
  }
}

/** Watcher deletion is the only path that removes failed or conflict-retained worktrees. */
export async function purgeObjectiveDispatchWorktrees(args: {
  runtime: OrcaRuntimeService
  watcherId: string
  objectiveStore: ObjectiveStore
}): Promise<void> {
  const records = args.objectiveStore.listDispatches(args.watcherId)
  const byWorkspace = new Map<string, ObjectiveDispatchRecord>()
  for (const record of records) {
    if (!isPendingWorkspace(record) && record.setupState !== 'cleaned') {
      byWorkspace.set(record.workspaceId, record)
    }
  }
  for (const record of byWorkspace.values()) {
    const cleanup = { ...record, setupState: 'cleanup-pending' as const }
    args.objectiveStore.saveDispatch(cleanup)
    await removeDispatchWorktree(args.runtime, cleanup)
    for (const sibling of records) {
      if (sibling.workspaceId === cleanup.workspaceId) {
        args.objectiveStore.saveDispatch({ ...sibling, setupState: 'cleaned' })
      }
    }
  }
}

function markerFingerprint(comment: string, watcherId: string): string | null {
  const prefix = `${DISPATCH_WORKTREE_MARKER_PREFIX}${watcherId}:`
  return comment.startsWith(prefix) ? comment.slice(prefix.length) || null : null
}

/** Repairs setup/cleanup interrupted by restart while retaining unowned dispatch-like children. */
export async function reconcileObjectiveDispatchWorktrees(args: {
  runtime: OrcaRuntimeService
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  lease: LeaseGuard
  workerReleaseConfirmed: (dispatchId: string) => boolean
}): Promise<void> {
  const watcherId = args.binding.enrollment.watcherId
  const records = args.objectiveStore.listDispatches(watcherId)
  const recordsByFingerprint = new Map(records.map((record) => [record.attemptFingerprint, record]))
  const listed = await args.runtime.listManagedWorktrees(`id:${args.binding.enrollment.repoId}`)
  const children = listed.worktrees.filter(
    (worktree) => markerFingerprint(worktree.comment, watcherId) !== null
  )

  for (const child of children) {
    const fingerprint = markerFingerprint(child.comment, watcherId) as string
    const record = recordsByFingerprint.get(fingerprint)
    if (!record) {
      await args.lease.assertHeld()
      args.objectiveStore.setParallelNote(
        watcherId,
        `Retained unowned dispatch-like worktree ${child.displayName} for operator inspection.`
      )
      continue
    }
    if (child.hostId && child.hostId !== record.executionHostId) {
      await args.lease.assertHeld()
      args.objectiveStore.setParallelNote(
        watcherId,
        `Retained dispatch-like worktree ${child.displayName}: its execution host does not match its durable dispatch record.`
      )
      continue
    }
    if (
      (isPendingWorkspace(record) || record.setupState === 'pending') &&
      child.head !== record.baseCommit
    ) {
      await args.lease.assertHeld()
      args.objectiveStore.saveDispatch({
        ...record,
        state: 'failed',
        workspaceId: child.id,
        workspacePath: child.path,
        setupState: 'retained',
        completedAtMs: record.completedAtMs ?? Date.now()
      })
      args.objectiveStore.setParallelNote(
        watcherId,
        `Retained dispatch worktree ${child.displayName}: it did not start at the enrolled HEAD recorded for the dispatch.`
      )
      continue
    }
    if (isPendingWorkspace(record) || record.setupState === 'pending') {
      const repaired = {
        ...record,
        workspaceId: child.id,
        workspacePath: child.path,
        setupState: 'ready' as const
      }
      await args.lease.assertHeld()
      args.objectiveStore.saveDispatch(repaired)
      recordsByFingerprint.set(fingerprint, repaired)
    }
  }
  const listedWorkspaceIds = new Set(
    listed.worktrees
      .filter(
        (worktree) =>
          !worktree.hostId || worktree.hostId === args.binding.enrollment.executionHostId
      )
      .map((worktree) => worktree.id)
  )

  for (const persisted of recordsByFingerprint.values()) {
    const record = args.objectiveStore.getDispatch(persisted.attemptFingerprint) ?? persisted
    if (record.setupState === 'cleaned') {
      continue
    }
    if (record.setupState === 'cleanup-pending') {
      if (workspaceMustBeRetained(args.objectiveStore, record)) {
        continue
      }
      if (!workspaceWorkersReleased(args.objectiveStore, record, args.workerReleaseConfirmed)) {
        continue
      }
      if (listedWorkspaceIds.has(record.workspaceId)) {
        await args.lease.assertHeld()
        await removeDispatchWorktree(args.runtime, record)
      }
      for (const sibling of args.objectiveStore.listDispatches(record.watcherId)) {
        if (sibling.workspaceId === record.workspaceId) {
          await args.lease.assertHeld()
          args.objectiveStore.saveDispatch({ ...sibling, setupState: 'cleaned' })
        }
      }
      continue
    }
    if (!isPendingWorkspace(record) && !listedWorkspaceIds.has(record.workspaceId)) {
      await args.lease.assertHeld()
      args.objectiveStore.saveDispatch({
        ...record,
        state: 'failed',
        setupState: 'retained',
        completedAtMs: record.completedAtMs ?? Date.now()
      })
      continue
    }
    if (isPendingWorkspace(record) || record.setupState === 'pending') {
      await args.lease.assertHeld()
      args.objectiveStore.saveDispatch({
        ...record,
        state: 'failed',
        setupState: 'retained',
        completedAtMs: record.completedAtMs ?? Date.now()
      })
      continue
    }
    await cleanupAppliedObjectiveDispatch({
      runtime: args.runtime,
      objectiveStore: args.objectiveStore,
      record,
      lease: args.lease,
      workerReleaseConfirmed: args.workerReleaseConfirmed
    })
  }
}
