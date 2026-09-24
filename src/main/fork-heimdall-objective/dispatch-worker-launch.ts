import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { DispatchResult, ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type {
  ObjectiveEnrollmentPayload,
  ObjectiveRole
} from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { resolveObjectiveRoleLaunch } from './role-launch'
import type { ObjectiveStore } from './objective-store'
import type { PreparedObjectiveDispatchWorkspace } from './dispatch-worktree'

type ObjectiveDispatchWorkerSpec = {
  role: ObjectiveRole
  spec: string
  taskKey?: string
  deps?: string[]
}

/** Marks a prepared dispatch record failed; a no-op when no workspace was prepared for this attempt. */
export async function saveDispatchFailure(
  objectiveStore: ObjectiveStore,
  prepared: PreparedObjectiveDispatchWorkspace | null,
  context: ExecuteContext<ObjectiveWorld>
): Promise<void> {
  if (!prepared) {
    return
  }
  await context.lease.assertHeld()
  objectiveStore.saveDispatch({
    ...prepared.record,
    state: 'failed',
    setupState: 'retained',
    completedAtMs: prepared.record.completedAtMs ?? Date.now()
  })
}

/** Sends the resolved worker request and reconciles the dispatch record against the outcome. */
export async function dispatchObjectiveWorker(args: {
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  request: ObjectiveDispatchWorkerSpec
  agent: string
  contract: Pick<ObjectiveEnrollmentPayload, 'roleLaunch'>
  prepared: PreparedObjectiveDispatchWorkspace | null
  serialReuseTerminal: string | null
  reportPath: string
}): Promise<ActionOutcome> {
  const {
    context,
    objectiveStore,
    request,
    agent,
    contract,
    prepared,
    serialReuseTerminal,
    reportPath
  } = args
  await context.lease.assertHeld()
  let result: DispatchResult
  try {
    result = await context.dispatchWorker({
      spec: request.spec,
      agent,
      ...(request.taskKey === undefined ? {} : { taskKey: request.taskKey }),
      ...(request.deps === undefined ? {} : { deps: request.deps }),
      ...(prepared === null ? {} : { workspaceId: prepared.record.workspaceId }),
      ...(prepared?.reuseTerminal || serialReuseTerminal
        ? { reuseTerminal: prepared?.reuseTerminal ?? serialReuseTerminal ?? undefined }
        : {}),
      ...resolveObjectiveRoleLaunch(contract, request.role)
    })
  } catch (error) {
    await saveDispatchFailure(objectiveStore, prepared, context)
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (result.status === 'refused') {
    await saveDispatchFailure(objectiveStore, prepared, context)
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: result.reason,
      result: { detail: result.detail }
    }
  }
  if (result.status === 'indeterminate') {
    return { effect: 'indeterminate', reason: 'dispatch-indeterminate', result }
  }
  if (prepared) {
    const completedRecord: ObjectiveDispatchRecord = {
      ...prepared.record,
      dispatchId: result.dispatchId,
      terminalHandle: result.terminalHandle ?? prepared.reuseTerminal,
      setupState: 'ready',
      reportPath
    }
    await context.lease.assertHeld()
    objectiveStore.saveDispatch(completedRecord)
    if (completedRecord.state === 'resolving-conflict') {
      for (const record of objectiveStore.listDispatches(completedRecord.watcherId)) {
        if (
          record.attemptFingerprint !== completedRecord.attemptFingerprint &&
          record.workspaceId === completedRecord.workspaceId &&
          record.taskKey === completedRecord.taskKey &&
          record.state === 'resolving-conflict'
        ) {
          await context.lease.assertHeld()
          objectiveStore.saveDispatch({
            ...record,
            state: 'discarded',
            setupState: 'retained',
            completedAtMs: record.completedAtMs ?? Date.now()
          })
        }
      }
    }
  }
  return {
    effect: 'landed',
    result: {
      dispatchId: result.dispatchId,
      reportPath,
      ...(result.terminalHandle ? { terminalHandle: result.terminalHandle } : {})
    }
  }
}
