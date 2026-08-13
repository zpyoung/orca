/** Run-worktree creation and best-effort teardown for git-hosted pipeline runs. */

import type { OrcaRuntimeService } from '../orca-runtime'
import { pipelineBranchName, pipelineBranchSlug } from './pipeline-branch-name'

export type PipelineRunWorktree = { branch: string; runWorktreeId: string }

const REFS_HEADS_PREFIX = 'refs/heads/'

/** Some hosts hand back the full ref; the contracted branch identity is always the short name. */
function toShortBranchName(ref: string): string {
  return ref.startsWith(REFS_HEADS_PREFIX) ? ref.slice(REFS_HEADS_PREFIX.length) : ref
}

async function branchExists(
  runtime: OrcaRuntimeService,
  repoId: string,
  branchName: string
): Promise<boolean> {
  const result = await runtime.searchRepoRefs(repoId, branchName)
  return result.refs.includes(`${REFS_HEADS_PREFIX}${branchName}`)
}

/**
 * Resolves a `pipeline/<slug>-<runNumber>` branch name that is free in the target repo right now.
 * Searches past any collision itself (no attempt cap) so the name handed to the worktree creator
 * is already known-free — the creator's own collision handling is for names that collide *after*
 * this check runs, not a substitute for this search, since it would otherwise silently check out
 * and advance whatever branch already sits at the intended base commit.
 */
export async function resolvePipelineRunBranchName(args: {
  runtime: OrcaRuntimeService
  repoId: string
  templateName: string
  runNumber: number
}): Promise<{ slug: string; branchName: string }> {
  const slug = pipelineBranchSlug(args.templateName)
  const branchName = await pipelineBranchName(slug, args.runNumber, (candidate) =>
    branchExists(args.runtime, args.repoId, candidate)
  )
  return { slug, branchName }
}

/**
 * Creates the run's single worktree on `branchName`, based at `baseCommit`, via the runtime's
 * existing worktree-creation path so SSH targets route through the relay. Throws on failure; the
 * caller is responsible for run-state compensation.
 */
export async function createPipelineRunWorktree(args: {
  runtime: OrcaRuntimeService
  repoId: string
  originWorktreeId: string
  baseCommit: string
  slug: string
  runNumber: number
  branchName: string
}): Promise<PipelineRunWorktree> {
  const created = await args.runtime.createManagedWorktree({
    repoSelector: args.repoId,
    name: `${args.slug}-${args.runNumber}`,
    baseBranch: args.baseCommit,
    branchNameOverride: args.branchName,
    activate: false,
    lineage: { parentWorktree: args.originWorktreeId }
  })

  return { branch: toShortBranchName(created.worktree.branch), runWorktreeId: created.worktree.id }
}

/**
 * Best-effort cleanup after a run whose worktree setup failed. Removes only the worktree the
 * creator's own return value identified with certainty. If the creator threw before handing
 * back an id, there is no trustworthy identity to act on — not even the branch name we asked
 * for, since a collision walk can hand a *different* run that same name — so this does nothing
 * rather than guess which worktree to force-remove.
 */
export async function removePipelineRunWorktreeBestEffort(
  runtime: OrcaRuntimeService,
  args: { runWorktreeId: string | undefined }
): Promise<void> {
  if (!args.runWorktreeId) {
    return
  }
  try {
    await runtime.removeManagedWorktree(args.runWorktreeId, true)
  } catch {
    // best-effort: the run is already terminal-failed regardless of whether this succeeds
  }
}
