import type { HostedReviewProvider } from '../../shared/hosted-review'
import type { HostedReviewCreationProvider } from '../../shared/hosted-review-creation-providers'
import { localGitOptionsForTarget } from '../runtime/runtime-git-command-target'
import {
  detectHostedReviewProvider,
  getForgeProviderForRepository,
  type ForgeProvider,
  type ForgeProviderRepositoryContext
} from '../source-control/forge-provider'
import { invalidateHostedReviewBranchCache } from '../source-control/hosted-review-branch-cache'
import { isProviderAuthenticated } from '../source-control/hosted-review-creation-provider'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import { getRepoDefaultBranchName } from '../source-control/repo-default-branch'
import type { ObjectiveWorkspaceTarget } from './content-identity'

export type ObjectiveForgeAccess = {
  detectProvider(context: ForgeProviderRepositoryContext): Promise<HostedReviewProvider>
  getProvider(context: ForgeProviderRepositoryContext): Promise<ForgeProvider | null>
  getDefaultBranch(context: ForgeProviderRepositoryContext): Promise<string | null>
  isAuthenticated(
    provider: HostedReviewCreationProvider,
    context: ForgeProviderRepositoryContext
  ): Promise<boolean>
  invalidate(context: ForgeProviderRepositoryContext): void
}

export function objectiveForgeContext(
  target: ObjectiveWorkspaceTarget
): ForgeProviderRepositoryContext {
  const localGitOptions = target.gitTarget ? localGitOptionsForTarget(target.gitTarget) : undefined
  return {
    repoPath: target.workspacePath,
    executionHostId: target.executionHostId,
    ...(localGitOptions ? { localGitExecOptions: localGitOptions } : {})
  }
}

export const defaultObjectiveForgeAccess: ObjectiveForgeAccess = {
  detectProvider: detectHostedReviewProvider,
  getProvider: getForgeProviderForRepository,
  getDefaultBranch: (context) =>
    getRepoDefaultBranchName(
      context.repoPath,
      hostedReviewSshConnectionId(context.executionHostId),
      context.localGitExecOptions
    ),
  isAuthenticated: (provider, context) =>
    isProviderAuthenticated(provider, context.repoPath, context.executionHostId, context),
  invalidate: (context) =>
    invalidateHostedReviewBranchCache(context.repoPath, context.executionHostId)
}
