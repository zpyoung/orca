import { SshGitWorkingTreeProvider } from '../providers/ssh-git-working-tree-provider'
import {
  HOSTED_REVIEW_BRANCH_UPDATE_RPC_TIMEOUT_MS,
  HOSTED_REVIEW_COMMIT_PUSH_RPC_TIMEOUT_MS,
  type HostedReviewBranchUpdateInput,
  type HostedReviewBranchUpdateResult,
  type HostedReviewCommitPushInput
} from '../../shared/fork-hosted-review-sitter/git-branch-update'

export class HostedReviewSitterSshGitProvider extends SshGitWorkingTreeProvider {
  readonly hostedReviewSitter = {
    pushCommit: (input: HostedReviewCommitPushInput, signal?: AbortSignal) =>
      this.runWithGitReadInvalidation(async () => {
        await this.mux.request('git.pushHostedReviewCommit', input, {
          signal,
          timeoutMs: HOSTED_REVIEW_COMMIT_PUSH_RPC_TIMEOUT_MS
        })
      }),
    updateBranch: (
      input: HostedReviewBranchUpdateInput,
      signal?: AbortSignal
    ): Promise<HostedReviewBranchUpdateResult> =>
      this.runWithGitReadInvalidation(
        async () =>
          (await this.mux.request('git.hostedReviewBranchUpdate', input, {
            signal,
            timeoutMs: HOSTED_REVIEW_BRANCH_UPDATE_RPC_TIMEOUT_MS
          })) as HostedReviewBranchUpdateResult
      )
  }
}
