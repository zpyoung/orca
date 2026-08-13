/** Interprets an in-flight dispatch's current task status into a driver-actionable outcome. */

import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type { PipelineRunDb } from '../orchestration/pipeline-run-db'
import type { PipelineCheckpointBackend } from './pipeline-checkpoint'
import {
  resolveFailedAttempt,
  resolveReadiedAttempt,
  type FailedAttemptResolution
} from './pipeline-driver-failure'
import type { PipelineInFlightDispatch } from './pipeline-driver-types'

export type PollOutcome = { kind: 'pending' } | { kind: 'succeeded' } | FailedAttemptResolution

export async function pollInFlightDispatch(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  pipelineDb: PipelineRunDb
  runId: string
  worktreeId: string
  checkpointBackend?: PipelineCheckpointBackend
  worktreePath?: string
  inFlight: PipelineInFlightDispatch
  taskStatus: string
}): Promise<PollOutcome> {
  const { db, runtime, pipelineDb, runId, worktreeId, checkpointBackend, worktreePath, inFlight } =
    args

  if (args.taskStatus === 'completed') {
    pipelineDb.endAttempt(runId, inFlight.node.id, inFlight.attempt, { outcome: 'succeeded' })
    pipelineDb.setNodeOutcome(runId, inFlight.node.id, { outcome: 'succeeded' })
    return { kind: 'succeeded' }
  }

  if (args.taskStatus === 'ready') {
    return resolveReadiedAttempt({
      pipelineDb,
      runId,
      node: inFlight.node,
      attempt: inFlight.attempt,
      checkpointBackend,
      worktreePath,
      checkpoint: inFlight.checkpoint
    })
  }

  if (args.taskStatus !== 'failed' && args.taskStatus !== 'blocked') {
    return { kind: 'pending' }
  }

  const dispatch = db.getDispatchContext(inFlight.taskId)
  const worker = dispatch ? db.getWorkerDispatch(dispatch.id) : undefined
  const workerState: 'failed' | 'start_unknown' =
    worker?.state === 'start_unknown' ? 'start_unknown' : 'failed'

  return resolveFailedAttempt({
    db,
    runtime,
    pipelineDb,
    runId,
    worktreeId,
    checkpointBackend,
    worktreePath,
    ctx: {
      node: inFlight.node,
      taskId: inFlight.taskId,
      attempt: inFlight.attempt,
      dispatchId: inFlight.dispatchId,
      terminalHandle: inFlight.terminalHandle,
      checkpoint: inFlight.checkpoint,
      workerState,
      attemptAlreadyBegun: true
    }
  })
}
