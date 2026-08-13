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

async function findWorktreeIdByBranch(
  runtime: OrcaRuntimeService,
  repoId: string,
  branchName: string
): Promise<string | undefined> {
  const { worktrees } = await runtime.listManagedWorktrees(repoId)
  return worktrees.find((worktree) => toShortBranchName(worktree.branch) === branchName)?.id
}

/**
 * Best-effort cleanup after a run whose worktree setup failed. The creator can create the git
 * worktree and branch and still throw before handing back an id, so this falls back to looking
 * the worktree up by the branch we asked it to create when no id came back.
 */
export async function removePipelineRunWorktreeBestEffort(
  runtime: OrcaRuntimeService,
  args: { repoId: string; branchName: string; runWorktreeId: string | undefined }
): Promise<void> {
  try {
    const targetId =
      args.runWorktreeId ?? (await findWorktreeIdByBranch(runtime, args.repoId, args.branchName))
    if (targetId) {
      await runtime.removeManagedWorktree(targetId, true)
    }
  } catch {
    // best-effort: the run is already terminal-failed regardless of whether this succeeds
  }
}
