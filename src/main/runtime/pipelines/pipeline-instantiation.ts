/**
 * Turns a client-resolved pipeline definition into a persisted, running pipeline run: preflight
 * every node's launch config (and, for an SSH-hosted git workspace, the relay checkpoint support
 * gate) → the L4 storage transaction → branch and worktree creation → running (logic L3, L4, L4b,
 * L8, L10, E1, E13).
 */

import type { ResolvedPipelineDefinition } from '../../../shared/pipeline-template-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type { PipelineRunDb } from '../orchestration/pipeline-run-db'
import { checkSshCheckpointGate, resolvePreflightExecutionHost } from './pipeline-instantiation-host'
import {
  createPipelineRunWorktree,
  removePipelineRunWorktreeBestEffort
} from './pipeline-instantiation-worktree'
import { validatePipelineNodeLaunch } from './pipeline-preflight'

export type InstantiatePipelineRunSuccess = {
  runId: string
  runNumber: number
  branch?: string
  runWorktreeId?: string
}

export type InstantiatePipelineRunRefusal = {
  refused: { nodeId?: string; field?: string; message: string }
}

export type InstantiatePipelineRunOutcome =
  | InstantiatePipelineRunSuccess
  | InstantiatePipelineRunRefusal

function refusal(message: string, nodeId?: string, field?: string): InstantiatePipelineRunRefusal {
  return { refused: { nodeId, field, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function instantiatePipelineRun(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  pipelineDb: PipelineRunDb
  worktreeSelector: string
  definition: ResolvedPipelineDefinition
}): Promise<InstantiatePipelineRunOutcome> {
  const { runtime, pipelineDb, worktreeSelector, definition } = args

  const originWorktree = await runtime.showManagedWorktree(worktreeSelector)
  const repo = await runtime.showRepo(originWorktree.repoId)
  const isFolderWorkspace = isFolderRepo(repo)
  const host = resolvePreflightExecutionHost(runtime, repo, originWorktree.id)

  for (const node of definition.nodes) {
    const result = await validatePipelineNodeLaunch({ runtime, node, host })
    if (!result.ok) {
      return refusal(result.message, result.nodeId, result.field)
    }
  }

  // Folder workspaces have no checkpoints to gate (L10/E1); only an SSH-hosted git workspace
  // needs the relay probed, and it happens here — alongside the node checks, before anything
  // is persisted — never after the transaction or worktree creation (E2 amendment A2).
  if (!isFolderWorkspace && repo.connectionId) {
    const gate = await checkSshCheckpointGate(repo.connectionId)
    if (!gate.ok) {
      return refusal(gate.message)
    }
  }

  const instantiated = pipelineDb.instantiate({
    definition,
    workspaceId: originWorktree.id,
    workspaceDisplayName: originWorktree.displayName,
    baseCommit: isFolderWorkspace ? null : originWorktree.head
  })

  if (isFolderWorkspace) {
    pipelineDb.updateRunState(instantiated.runId, 'running')
    return { runId: instantiated.runId, runNumber: instantiated.runNumber }
  }

  let createdWorktreeId: string | undefined
  try {
    const worktree = await createPipelineRunWorktree({
      runtime,
      repoId: repo.id,
      originWorktreeId: originWorktree.id,
      baseCommit: originWorktree.head,
      templateName: definition.templateName,
      runNumber: instantiated.runNumber
    })
    createdWorktreeId = worktree.runWorktreeId
    pipelineDb.recordWorktreeSetup(instantiated.runId, worktree)
    pipelineDb.updateRunState(instantiated.runId, 'running')
    return { runId: instantiated.runId, runNumber: instantiated.runNumber, ...worktree }
  } catch (error) {
    // L4b: the transaction already committed, so this is a terminal setup failure, not a
    // refusal that leaves nothing behind — the run keeps its allocated number and appears in
    // history; recovery is starting a new run, which is why the caller still only sees a
    // refusal shape here (nothing to hand a driver, nothing to dispatch).
    const message = `Failed to set up the run worktree: ${messageOf(error)}`
    pipelineDb.updateRunState(instantiated.runId, 'failed', { failureReason: message })
    if (createdWorktreeId) {
      await removePipelineRunWorktreeBestEffort(runtime, createdWorktreeId)
    }
    return refusal(message)
  }
}
