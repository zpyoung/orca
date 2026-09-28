import type {
  HostedReviewBranchUpdateInput,
  HostedReviewBranchUpdateResult,
  HostedReviewCommitPushInput
} from '../../shared/fork-hosted-review-sitter/git-branch-update'
import {
  HOSTED_REVIEW_BRANCH_UPDATE_RPC_TIMEOUT_MS,
  HOSTED_REVIEW_COMMIT_PUSH_RPC_TIMEOUT_MS,
  HOSTED_REVIEW_CONFIRMED_NOT_LANDED_MESSAGE,
  HOSTED_REVIEW_EXPECTED_STATE_MISMATCH_MESSAGE
} from '../../shared/fork-hosted-review-sitter/git-branch-update'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { SshGitWorkingTreeProvider } from '../providers/ssh-git-working-tree-provider'

const JSON_RPC_SERVER_ERROR = -32_000

function mapHostedReviewGitMutationError(error: unknown): never {
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === JSON_RPC_SERVER_ERROR &&
    error.message === HOSTED_REVIEW_EXPECTED_STATE_MISMATCH_MESSAGE
  ) {
    throw Object.assign(error, {
      effect: 'not-landed' as const,
      reason: 'expected-state-mismatch' as const
    })
  }
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === JSON_RPC_SERVER_ERROR &&
    error.message === HOSTED_REVIEW_CONFIRMED_NOT_LANDED_MESSAGE
  ) {
    throw Object.assign(error, {
      effect: 'not-landed' as const,
      reason: 'remote-unchanged-after-push-error' as const
    })
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === JsonRpcErrorCode.MethodNotFound
  ) {
    throw Object.assign(
      new Error(
        'The connected SSH relay does not support hosted review Git mutations; reconnect to deploy the latest relay.'
      ),
      { effect: 'not-landed' as const, reason: 'unsupported-capability' as const }
    )
  }
  throw error
}

export class HostedReviewSitterSshGitProvider extends SshGitWorkingTreeProvider {
  readonly hostedReviewSitter = {
    pushCommit: async (input: HostedReviewCommitPushInput, signal?: AbortSignal) => {
      try {
        await this.runWithGitReadInvalidation(async () => {
          await this.mux.request('git.pushHostedReviewCommit', input, {
            signal,
            timeoutMs: HOSTED_REVIEW_COMMIT_PUSH_RPC_TIMEOUT_MS
          })
        })
      } catch (error) {
        mapHostedReviewGitMutationError(error)
      }
    },
    updateBranch: async (
      input: HostedReviewBranchUpdateInput,
      signal?: AbortSignal
    ): Promise<HostedReviewBranchUpdateResult> => {
      try {
        return await this.runWithGitReadInvalidation(
          async () =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: git.hostedReviewBranchUpdate's response shape is defined by the relay's JSON-RPC contract, not verifiable from this call site.
            (await this.mux.request('git.hostedReviewBranchUpdate', input, {
              signal,
              timeoutMs: HOSTED_REVIEW_BRANCH_UPDATE_RPC_TIMEOUT_MS
            })) as HostedReviewBranchUpdateResult
        )
      } catch (error) {
        mapHostedReviewGitMutationError(error)
      }
    }
  }
}
