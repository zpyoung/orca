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
  | {
      kind: 'started'
      response: OrchestrationWorkerStartResponse
      checkpoint?: PipelineCheckpointInfo
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
    launchPreferences: preferences
  })

  return { kind: 'started', response, checkpoint }
}

/** Best-effort interrupt for a dispatch that only resolved after the run had already aborted. */
export async function interruptAbortedDispatch(
  runtime: OrcaRuntimeService,
  outcome: PipelineDispatchOutcome
): Promise<void> {
  if (outcome.kind !== 'started') {
    return
  }
  const handle = extractDispatchTerminalHandle(outcome.response.effects)
  if (!handle) {
    return
  }
  try {
    await runtime.sendTerminal(handle, { interrupt: true })
  } catch {
    // abort only guarantees nothing further dispatches, not that the agent obeys \x03
  }
}
