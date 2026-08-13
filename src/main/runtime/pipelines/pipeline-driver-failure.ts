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
import {
  classifyPrelaunchStage,
  type PipelinePrelaunchStage
} from './pipeline-driver-stage-classify'
import type { PipelineCheckpointInfo } from './pipeline-driver-types'
import { verifyPtyStopped } from './pipeline-driver-verified-stop'
import { isTerminalPipelineRunState } from './pipeline-snapshot-publisher-assemble'

export type FailedAttemptContext = {
  node: ResolvedPipelineNode
  taskId: string
  attempt: number
  dispatchId: string
  terminalHandle?: string
  checkpoint?: PipelineCheckpointInfo
  workerState: 'failed' | 'start_unknown'
  /** The worker-start outcome's own `failedStage`/`lastError`, when this attempt failed during launch rather than being discovered later via polling. */
  failedStage?: string
  lastError?: string
  attemptAlreadyBegun: boolean
}

export type FailedAttemptResolution =
  | { kind: 'fail-node'; reason: string }
  | { kind: 'pending-retry'; attempt: number; retryOf?: string }

/** The durable worker-dispatch record is a second source for the handle beyond this attempt's own response effects. */
export function resolveVerifiableTerminalHandle(
  db: OrchestrationDb,
  ctx: Pick<FailedAttemptContext, 'dispatchId' | 'terminalHandle'>
): string | undefined {
  return ctx.terminalHandle ?? db.getWorkerDispatch(ctx.dispatchId)?.agent_terminal_handle ?? undefined
}

async function prepareRetryForRoute(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  worktreeId: string,
  stage: PipelinePrelaunchStage,
  ctx: Pick<FailedAttemptContext, 'dispatchId' | 'terminalHandle' | 'workerState'>
): Promise<PipelineRetryPreparation> {
  const terminalHandle = resolveVerifiableTerminalHandle(db, ctx)
  if (stage === 'C' && !terminalHandle) {
    // stage C means an agent may have run: unlike stage B, a missing handle can never stand in for a verified stop
    return {
      ok: false,
      reason: "Could not identify the failed attempt's terminal to verify it had stopped."
    }
  }
  if (ctx.workerState === 'start_unknown') {
    return prepareBridgedRetry({
      db,
      runtime,
      worktreeId,
      dispatchId: ctx.dispatchId,
      terminalHandle
    })
  }
  return prepareDirectRetry({
    runtime,
    worktreeId,
    dispatchId: ctx.dispatchId,
    terminalHandle
  })
}

/** Shared tail for any consumed attempt (stage C, or a plain re-readied re-dispatch): budget check, then restore. */
async function finalizeConsumedAttempt(args: {
  node: ResolvedPipelineNode
  attempt: number
  retryOf?: string
  pipelineDb: PipelineRunDb
  runId: string
  checkpointBackend?: PipelineCheckpointBackend
  worktreePath?: string
  checkpoint?: PipelineCheckpointInfo
  exhaustedReason?: string
}): Promise<FailedAttemptResolution> {
  const attemptsAllowed = 1 + (args.node.onFailure?.retries ?? 0)
  if (args.attempt >= attemptsAllowed) {
    return { kind: 'fail-node', reason: args.exhaustedReason ?? 'attempts exhausted' }
  }

  if (args.checkpointBackend && args.worktreePath && args.checkpoint) {
    // read fresh right at the destructive call: abort can land asynchronously while this
    // resolution is in flight, and the worktree must never move once the run is terminal
    const run = args.pipelineDb.getPipelineRun(args.runId)
    if (run && !isTerminalPipelineRunState(run.state)) {
      await args.checkpointBackend.restore({
        worktreePath: args.worktreePath,
        head: args.checkpoint.head,
        snapshot: args.checkpoint.snapshot
      })
    }
  }

  return { kind: 'pending-retry', attempt: args.attempt + 1, retryOf: args.retryOf }
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
    // stage B means nothing ever spawned, so this budget stays separate from onFailure.retries and never consumes an attempt
    const retry = await prepareRetryForRoute(db, runtime, worktreeId, stage, ctx)
    if (!retry.ok) {
      return { kind: 'fail-node', reason: retry.reason }
    }
    return { kind: 'pending-retry', attempt: ctx.attempt, retryOf: retry.retryOf }
  }

  // the generic 'C' is the fallback for a failure discovered later via polling, which has no
  // worker-start outcome of its own to report a more specific stage from
  const failureStage = ctx.failedStage ?? 'C'
  if (ctx.attemptAlreadyBegun) {
    pipelineDb.endAttempt(runId, ctx.node.id, ctx.attempt, { outcome: 'failed', failureStage })
  } else {
    pipelineDb.beginAttempt(runId, ctx.node.id, {
      attempt: ctx.attempt,
      dispatchId: ctx.dispatchId,
      checkpoint: ctx.checkpoint
    })
    pipelineDb.endAttempt(runId, ctx.node.id, ctx.attempt, { outcome: 'failed', failureStage })
  }
  pipelineDb.resetPrelaunchFailures(runId, ctx.node.id)

  const retry = await prepareRetryForRoute(db, runtime, worktreeId, stage, ctx)
  if (!retry.ok) {
    return { kind: 'fail-node', reason: retry.reason }
  }

  return finalizeConsumedAttempt({
    node: ctx.node,
    attempt: ctx.attempt,
    retryOf: retry.retryOf,
    pipelineDb,
    runId,
    checkpointBackend,
    worktreePath,
    checkpoint: ctx.checkpoint,
    exhaustedReason: ctx.lastError ? `attempts exhausted: ${ctx.lastError}` : undefined
  })
}

/**
 * A task an external actor put back to `ready` while the driver still considered its dispatch
 * in flight (host recovery abandoning a missing worker terminal; an unexpected agent exit) has
 * no `retryOf`-eligible landing — `retryOf` requires the task in {failed, blocked}. Re-dispatch
 * it plainly instead, consuming a pipeline attempt like any other observed failure.
 *
 * An attempt was already dispatched, so its terminal may still be live — gate the re-dispatch on
 * the same verified stop a stage-C retry requires, failing terminally when it can't be confirmed.
 */
export async function resolveReadiedAttempt(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  pipelineDb: PipelineRunDb
  runId: string
  worktreeId: string
  node: ResolvedPipelineNode
  attempt: number
  dispatchId: string
  terminalHandle?: string
  checkpointBackend?: PipelineCheckpointBackend
  worktreePath?: string
  checkpoint?: PipelineCheckpointInfo
}): Promise<FailedAttemptResolution> {
  args.pipelineDb.endAttempt(args.runId, args.node.id, args.attempt, {
    outcome: 'failed',
    failureStage: 'reready'
  })
  args.pipelineDb.resetPrelaunchFailures(args.runId, args.node.id)

  const terminalHandle = resolveVerifiableTerminalHandle(args.db, args)
  if (!terminalHandle) {
    return {
      kind: 'fail-node',
      reason: "Could not identify the re-readied attempt's terminal to verify it had stopped."
    }
  }
  const stopped = await verifyPtyStopped(args.runtime, {
    worktreeId: args.worktreeId,
    terminalHandle
  })
  if (!stopped) {
    return {
      kind: 'fail-node',
      reason: "Could not confirm the re-readied attempt's terminal had stopped."
    }
  }

  return finalizeConsumedAttempt({ ...args, retryOf: undefined })
}
