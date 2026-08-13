/** The fixed per-dispatch sequence: pre-spawn revalidation, checkpoint, prompt assembly, launch. */

import {
  assemblePipelineDispatchPrompt,
  type PipelineDispatchDependency
} from '../../../shared/pipeline-dispatch-prompt'
import type { ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import {
  executeLocalWorkerStart,
  type OrchestrationWorkerStartResponse
} from '../rpc/methods/orchestration-worker-start-execution'
import { resolveWorkerLaunchPreferences } from '../rpc/methods/orchestration-worker-launch-preferences'
import type { PipelineCheckpointInfo } from './pipeline-driver-types'
import type { PipelineCheckpointBackend } from './pipeline-checkpoint'
import { validatePipelineNodeLaunch } from './pipeline-preflight'
import type { PreflightExecutionHost } from './pipeline-preflight-executable-presence'
import { extractDispatchTerminalHandle } from './pipeline-driver-stage-classify'

export type PipelineDispatchOutcome =
  | { kind: 'refused'; message: string }
  | { kind: 'abandoned' }
  | {
      kind: 'live'
      response: OrchestrationWorkerStartResponse
      checkpoint?: PipelineCheckpointInfo
      terminalHandle?: string
    }
  | {
      kind: 'settle'
      response: OrchestrationWorkerStartResponse
      checkpoint?: PipelineCheckpointInfo
      terminalHandle?: string
      workerState: 'failed' | 'start_unknown'
    }

function pipelineDriverIdentity(runId: string): string {
  return `pipeline-driver:${runId}`
}

/**
 * Every dispatch — first attempt, stage-B cycle, or stage-C retry — goes through this one
 * function, so a retry can never skip revalidation or launch with a stale prompt.
 */
export async function dispatchPipelineNode(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  node: ResolvedPipelineNode
  taskId: string
  worktreeId: string
  attempt: number
  host: PreflightExecutionHost
  checkpointBackend?: PipelineCheckpointBackend
  worktreePath?: string
  retryOf?: string
  dependencies: PipelineDispatchDependency[]
  isDispatchable: () => boolean
  onSpawnStarted?: (dispatchId: string) => void
}): Promise<PipelineDispatchOutcome> {
  const preflight = await validatePipelineNodeLaunch({
    runtime: args.runtime,
    node: args.node,
    host: args.host
  })
  if (!preflight.ok) {
    return { kind: 'refused', message: preflight.message }
  }

  let checkpoint: PipelineCheckpointInfo | undefined
  if (args.checkpointBackend && args.worktreePath) {
    checkpoint = await args.checkpointBackend.capture({
      worktreePath: args.worktreePath,
      runId: args.runId,
      nodeId: args.node.id,
      attempt: args.attempt
    })
  }

  const dispatchPrompt = assemblePipelineDispatchPrompt({
    snapshotPrompt: args.node.prompt,
    dependencies: args.dependencies
  })
  const { preferences } = resolveWorkerLaunchPreferences({
    agent: preflight.agent,
    model: args.node.model,
    effort: args.node.effort
  })

  // last check before the point of no return: pause/abort issued during preflight or checkpoint
  // capture must still stop a launch that hasn't committed yet
  if (!args.isDispatchable()) {
    return { kind: 'abandoned' }
  }

  const response = await executeLocalWorkerStart({
    runtime: args.runtime,
    db: args.db,
    runId: args.runId,
    taskId: args.taskId,
    worktreeId: args.worktreeId,
    from: pipelineDriverIdentity(args.runId),
    dispatchPrompt,
    retryOf: args.retryOf,
    launch: 'new-terminal',
    agent: preflight.agent,
    launchPreferences: preferences,
    // the durable spawn receipt exists as soon as the PTY commits, well before the readiness
    // wait — surface it here so an in-flight attempt is abortable before this call returns
    onPtySpawnCommitted: args.onSpawnStarted
      ? () => {
          const dispatch = args.db.getDispatchContext(args.taskId)
          if (dispatch) {
            args.onSpawnStarted?.(dispatch.id)
          }
        }
      : undefined
  })
  const terminalHandle = extractDispatchTerminalHandle(response.effects)

  if (response.state === 'failed' || response.state === 'outcome_unknown') {
    return {
      kind: 'settle',
      response,
      checkpoint,
      terminalHandle,
      workerState: response.state === 'outcome_unknown' ? 'start_unknown' : 'failed'
    }
  }
  return { kind: 'live', response, checkpoint, terminalHandle }
}

/** Best-effort interrupt for a dispatch that only resolved after the run had already aborted. */
export async function interruptAbortedDispatch(
  runtime: OrcaRuntimeService,
  outcome: PipelineDispatchOutcome
): Promise<void> {
  if (outcome.kind !== 'live' && outcome.kind !== 'settle') {
    return
  }
  if (!outcome.terminalHandle) {
    return
  }
  try {
    await runtime.sendTerminal(outcome.terminalHandle, { interrupt: true })
  } catch {
    // abort only guarantees nothing further dispatches, not that the agent obeys \x03
  }
}
