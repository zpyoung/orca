import type { AutomationSchedulerOwner } from '../../shared/automations-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { AuthorizedEnrollment, EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewEnrollmentPayload,
  HostedReviewSitterCapabilities,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import type { Store } from '../persistence'
import { getAutomationSchedulerOwner } from '../persistence/scheduling-automations/automation-context-migration'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { parseHostedReviewEnrollmentPayload } from './definition-store'

const CAPABILITY_KEYS = ['updateBranch', 'resolveConflicts', 'fixChecks', 'merge'] as const

function parseCapabilities(value: EnrollInput['capabilities']): HostedReviewSitterCapabilities {
  const keys = Object.keys(value).sort()
  if (
    keys.length !== CAPABILITY_KEYS.length ||
    CAPABILITY_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error('Hosted review enrollment requires exactly its four capability modes')
  }
  return {
    updateBranch: value.updateBranch!,
    resolveConflicts: value.resolveConflicts!,
    fixChecks: value.fixChecks!,
    merge: value.merge!
  }
}

export type AuthorizedHostedReviewSitterDefinition = HostedReviewSitterDefinition
export class HostedReviewOwnerNotExecutableError extends Error {
  readonly schedulerOwner: AutomationSchedulerOwner

  constructor(schedulerOwner: AutomationSchedulerOwner) {
    super(`Hosted review watcher owner is not executable: ${schedulerOwner}`)
    this.name = 'HostedReviewOwnerNotExecutableError'
    this.schedulerOwner = schedulerOwner
  }
}

/**
 * Rebuilds every workspace and provider identity field from Store, Git, and the forge.
 * Renderer values select a candidate only; none becomes persisted authority.
 */
export async function authorizeHostedReviewSitterDefinition(
  runtime: OrcaRuntimeService,
  store: Store,
  input: EnrollInput,
  storageAuthority: 'desktop' | 'runtime' = 'desktop'
): Promise<AuthorizedEnrollment> {
  if (input.kind !== 'hosted-review' || !input.worktreeId) {
    throw new Error('Hosted review enrollment requires an explicit Git worktree')
  }
  const candidatePayload = parseHostedReviewEnrollmentPayload(input.kindPayload)
  if (!candidatePayload) {
    throw new Error('Invalid hosted review enrollment payload')
  }
  const repo = store.getRepo(input.repoId)
  if (!repo) {
    throw new Error('Hosted review sitter repository is unavailable')
  }
  const routeOwner = getAutomationSchedulerOwner(repo)
  if (
    (storageAuthority === 'desktop' && routeOwner === 'remote_host_service') ||
    (storageAuthority === 'runtime' && routeOwner !== 'local_host_service')
  ) {
    throw new HostedReviewOwnerNotExecutableError(routeOwner)
  }
  const schedulerOwner = storageAuthority === 'runtime' ? 'remote_host_service' : routeOwner
  const workspace = await runtime.showManagedWorktree(`id:${input.worktreeId}`)
  if (workspace.repoId !== repo.id || workspace.id !== input.worktreeId) {
    throw new Error('Invalid hosted review sitter worktree identity')
  }

  const worktree = workspace.git
  if (!worktree.path || worktree.isBare || worktree.prunable || !worktree.branch) {
    throw new Error('Hosted review sitter worktree is unavailable or detached')
  }
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  if (!branch) {
    throw new Error('Hosted review sitter requires an attached branch')
  }

  const executionHostId = getRepoExecutionHostId(repo)
  const metadata = store.getWorktreeMeta(workspace.id)
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
    throw new Error('Only an open hosted review can be enrolled')
  }

  const kindPayload: HostedReviewEnrollmentPayload = {
    branch,
    provider: review.provider,
    reviewNumber: review.number,
    reviewUrl: review.url,
    branchUpdateMode: candidatePayload.branchUpdateMode,
    mergeMethod: candidatePayload.mergeMethod
  }
  return {
    kind: 'hosted-review',
    workspaceKey: `${executionHostId}::${worktree.path}`,
    executionHostId,
    repoId: repo.id,
    worktreeId: workspace.id,
    workspacePath: worktree.path,
    schedulerOwner,
    capabilities: parseCapabilities(input.capabilities),
    budget: structuredClone(input.budget),
    kindPayload
  }
}

export function hostedReviewDefinitionFromEnrollment(
  enrollment: Pick<
    AuthorizedEnrollment,
    'repoId' | 'worktreeId' | 'workspacePath' | 'capabilities' | 'kindPayload'
  >
): HostedReviewSitterDefinition {
  if (!enrollment.worktreeId) {
    throw new Error('Hosted review enrollment lost its Git worktree identity')
  }
  const payload = parseHostedReviewEnrollmentPayload(enrollment.kindPayload)
  if (!payload) {
    throw new Error('Hosted review enrollment payload is invalid')
  }
  return {
    repoId: enrollment.repoId,
    worktreeId: enrollment.worktreeId,
    repoPath: enrollment.workspacePath,
    capabilities: parseCapabilities(enrollment.capabilities),
    ...payload
  }
}
