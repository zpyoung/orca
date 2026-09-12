import type { HostedReviewSitterArmInput } from '../../shared/fork-hosted-review-sitter/api'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { getRepoHostedReviewExecutionHostId } from '../source-control/hosted-review-execution-host'

export type AuthorizedHostedReviewSitterDefinition = Omit<
  HostedReviewSitterDefinition,
  'id' | 'enabled'
>

/**
 * Rebuilds every workspace/provider identity field from Store, Git and the forge.
 * Renderer values select a candidate only; none becomes persisted authority.
 */
export async function authorizeHostedReviewSitterDefinition(
  runtime: OrcaRuntimeService,
  store: Store,
  input: HostedReviewSitterArmInput
): Promise<AuthorizedHostedReviewSitterDefinition> {
  const repo = store.getRepo(input.repoId)
  if (!repo) {
    throw new Error('Hosted review sitter repository is unavailable')
  }
  const workspace = await runtime.showManagedWorktree(`id:${input.worktreeId}`)
  if (workspace.repoId !== repo.id) {
    throw new Error('Invalid hosted review sitter worktree identity')
  }

  const executionHostId = getRepoHostedReviewExecutionHostId(repo)
  if (
    getRepoExecutionHostId(repo).startsWith('runtime:') &&
    executionHostId === LOCAL_EXECUTION_HOST_ID
  ) {
    throw new Error('Hosted review sitter cannot arm a client-owned runtime workspace')
  }

  const worktree = workspace.git
  if (!worktree.path || worktree.isBare || worktree.prunable || !worktree.branch) {
    throw new Error('Hosted review sitter worktree is unavailable or detached')
  }
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  if (!branch) {
    throw new Error('Hosted review sitter requires an attached branch')
  }

  const worktreeId = workspace.id
  const metadata = store.getWorktreeMeta(worktreeId)
  const review = await getHostedReviewForBranch({
    repoPath: worktree.path,
    executionHostId,
    branch,
    linkedGitHubPR: metadata?.linkedPR ?? null,
    linkedGitLabMR: metadata?.linkedGitLabMR ?? null,
    currentHeadOid: worktree.head || null,
    active: true,
    localGitExecOptions: {
      ...getLocalProjectWorktreeGitOptions(store, repo),
      admissionTier: 'interactive'
    }
  })
  if (!review || (review.provider !== 'github' && review.provider !== 'gitlab')) {
    throw new Error('No supported hosted review exists for this worktree branch')
  }
  if (review.state !== 'open' && review.state !== 'draft') {
    throw new Error('Only an open hosted review can be armed')
  }

  return {
    repoId: repo.id,
    worktreeId,
    repoPath: worktree.path,
    branch,
    provider: review.provider,
    reviewNumber: review.number,
    reviewUrl: review.url,
    capabilities: structuredClone(input.capabilities),
    activeBudgetMs: input.activeBudgetMs,
    branchUpdateMode: input.branchUpdateMode,
    mergeMethod: input.mergeMethod
  }
}
