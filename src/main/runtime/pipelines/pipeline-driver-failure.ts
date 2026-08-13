/** Stage B/C attempt accounting and retry preparation for one failed dispatch attempt. */

import type { ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type { PipelineRunDb } from '../orchestration/pipeline-run-db'
import type { PipelineCheckpointBackend } from './pipeline-checkpoint'
import {
  prepareBridgedRetry,
  prepareDirectRetry,
  type PipelineRetryPreparation
} from './pipeline-driver-retry'
import { classifyPrelaunchStage } from './pipeline-driver-stage-classify'
import type { PipelineCheckpointInfo } from './pipeline-driver-types'

export type FailedAttemptContext = {
  node: ResolvedPipelineNode
  taskId: string
  attempt: number
  dispatchId: string
  terminalHandle?: string
  checkpoint?: PipelineCheckpointInfo
  workerState: 'failed' | 'start_unknown'
  attemptAlreadyBegun: boolean
}

export type FailedAttemptResolution =
  | { kind: 'fail-node'; reason: string }
  | { kind: 'pending-retry'; attempt: number; retryOf?: string }

async function prepareRetryForRoute(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  worktreeId: string,
  ctx: Pick<FailedAttemptContext, 'dispatchId' | 'terminalHandle' | 'workerState'>
): Promise<PipelineRetryPreparation> {
  if (ctx.workerState === 'start_unknown') {
    return prepareBridgedRetry({
      db,
      runtime,
      worktreeId,
      dispatchId: ctx.dispatchId,
      terminalHandle: ctx.terminalHandle
    })
  }
  return prepareDirectRetry({
    runtime,
    worktreeId,
    dispatchId: ctx.dispatchId,
    terminalHandle: ctx.terminalHandle
  })
}

/**
 * Resolves one failed attempt to either a terminal node failure or a prepared re-dispatch —
 * every DB write (attempt rows, the stage-B budget, checkpoint restore) happens here so the
 * caller only has to act on the verdict.
 */
export async function resolveFailedAttempt(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  pipelineDb: PipelineRunDb
  runId: string
  worktreeId: string
  checkpointBackend?: PipelineCheckpointBackend
  worktreePath?: string
  ctx: FailedAttemptContext
}): Promise<FailedAttemptResolution> {
  const { db, runtime, pipelineDb, runId, worktreeId, checkpointBackend, worktreePath, ctx } = args
  const stage = classifyPrelaunchStage(db.getSpawnReceipt(ctx.dispatchId))

  if (stage === 'B') {
    const count = pipelineDb.incrementPrelaunchFailures(runId, ctx.node.id)
    if (count >= 3) {
      return {
        kind: 'fail-node',
        reason: 'launch-rejected: prelaunch failures exhausted (3 consecutive)'
      }
    }
    const retry = await prepareRetryForRoute(db, runtime, worktreeId, ctx)
    if (!retry.ok) {
      return { kind: 'fail-node', reason: retry.reason }
    }
    return { kind: 'pending-retry', attempt: ctx.attempt, retryOf: retry.retryOf }
  }

  if (ctx.attemptAlreadyBegun) {
    pipelineDb.endAttempt(runId, ctx.node.id, ctx.attempt, { outcome: 'failed', failureStage: 'C' })
  } else {
    pipelineDb.beginAttempt(runId, ctx.node.id, {
      attempt: ctx.attempt,
      dispatchId: ctx.dispatchId,
      checkpoint: ctx.checkpoint
    })
    pipelineDb.endAttempt(runId, ctx.node.id, ctx.attempt, { outcome: 'failed', failureStage: 'C' })
  }
  pipelineDb.resetPrelaunchFailures(runId, ctx.node.id)

  const retry = await prepareRetryForRoute(db, runtime, worktreeId, ctx)
  if (!retry.ok) {
    return { kind: 'fail-node', reason: retry.reason }
  }

  const attemptsAllowed = 1 + (ctx.node.onFailure?.retries ?? 0)
  if (ctx.attempt >= attemptsAllowed) {
    return { kind: 'fail-node', reason: 'attempts exhausted' }
  }

  if (checkpointBackend && worktreePath && ctx.checkpoint) {
    await checkpointBackend.restore({
      worktreePath,
      head: ctx.checkpoint.head,
      snapshot: ctx.checkpoint.snapshot
    })
  }

  return { kind: 'pending-retry', attempt: ctx.attempt + 1, retryOf: retry.retryOf }
}
