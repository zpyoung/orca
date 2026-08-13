/** Run-worktree creation and best-effort teardown for git-hosted pipeline runs (logic L8, E13). */

import type { OrcaRuntimeService } from '../orca-runtime'
import { pipelineBranchName, pipelineBranchSlug } from './pipeline-branch-name'

export type PipelineRunWorktree = { branch: string; runWorktreeId: string }

/**
 * Creates the run's single worktree on a new `pipeline/<slug>-<runNumber>` branch, based at
 * `baseCommit`, via the runtime's existing worktree-creation path so SSH targets route through
 * the relay. Throws on failure; the caller is responsible for run-state compensation (L4b).
 */
export async function createPipelineRunWorktree(args: {
  runtime: OrcaRuntimeService
  repoId: string
  originWorktreeId: string
  baseCommit: string
  templateName: string
  runNumber: number
}): Promise<PipelineRunWorktree> {
  const slug = pipelineBranchSlug(args.templateName)
  // The base `pipeline/<slug>-<runNumber>` name is always free on the first try here — a fresh
  // run number was just allocated — so `existing` never needs a real check; collisions from
  // worktrees outside this allocation are handled by createManagedWorktree's own retry below.
  const branchName = await pipelineBranchName(slug, args.runNumber, async () => false)

  const created = await args.runtime.createManagedWorktree({
    repoSelector: args.repoId,
    name: `${slug}-${args.runNumber}`,
    baseBranch: args.baseCommit,
    branchNameOverride: branchName,
    activate: false,
    lineage: { parentWorktree: args.originWorktreeId }
  })

  return { branch: created.worktree.branch, runWorktreeId: created.worktree.id }
}

/** Best-effort cleanup of a worktree created for a run whose instantiation failed afterward. */
export async function removePipelineRunWorktreeBestEffort(
  runtime: OrcaRuntimeService,
  runWorktreeId: string
): Promise<void> {
  try {
    await runtime.removeManagedWorktree(runWorktreeId, true)
  } catch {
    // best-effort: the run is already terminal-failed regardless of whether this succeeds
  }
}
