import { GitHandlerOperationContext } from '../git-handler-operation-context'
import type { RelayDispatcher } from '../dispatcher'
import type { GitCapabilityCache } from '../../shared/git-capability-cache'
import {
  assertHostedReviewBranchUpdateInput,
  assertHostedReviewCommitPushInput,
  executeHostedReviewBranchUpdate,
  executeHostedReviewCommitPush
} from '../../shared/fork-hosted-review-sitter/git-branch-update'

type RunGit = (
  args: string[],
  cwd: string,
  options?: { signal?: AbortSignal; terminationBarrier?: boolean; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

type RequestContext = { signal?: AbortSignal }

export type HostedReviewRelayGitHandlers = {
  pushCommit(params: Record<string, unknown>, context?: RequestContext): Promise<void>
  updateBranch(params: Record<string, unknown>, context?: RequestContext): Promise<unknown>
}

function createHostedReviewRelayGitAdapter(input: {
  runGit: RunGit
  capabilities: GitCapabilityCache
  invalidate(): void
}): HostedReviewRelayGitHandlers {
  return {
    pushCommit: async (params, context) => {
      assertHostedReviewCommitPushInput(params)
      try {
        await executeHostedReviewCommitPush(
          (args) =>
            input.runGit(args, params.worktreePath, {
              signal: context?.signal,
              terminationBarrier: true
            }),
          params
        )
      } finally {
        input.invalidate()
      }
    },
    updateBranch: async (params, context) => {
      assertHostedReviewBranchUpdateInput(params)
      input.invalidate()
      try {
        return await executeHostedReviewBranchUpdate(
          (args) =>
            input.runGit(args, params.worktreePath, {
              signal: context?.signal,
              terminationBarrier: true
            }),
          input.capabilities,
          params,
          context?.signal,
          (args) =>
            input.runGit(args, params.worktreePath, {
              terminationBarrier: true,
              timeout: 30_000
            })
        )
      } finally {
        input.invalidate()
      }
    }
  }
}

export abstract class HostedReviewSitterRelayGitContext extends GitHandlerOperationContext {
  readonly hostedReviewSitter = createHostedReviewRelayGitAdapter({
    runGit: (args, cwd, options) => this.git(args, cwd, options),
    capabilities: this.gitCapabilities,
    invalidate: () => this.clearGitMutationReadCaches()
  })
}

/** Keeps both hosted-review relay RPC names behind one declared upstream registration seam. */
export function registerHostedReviewSitterGitHandlers(
  dispatcher: RelayDispatcher,
  handlers: { hostedReviewSitter: HostedReviewRelayGitHandlers }
): void {
  dispatcher.onRequest('git.pushHostedReviewCommit', (params, context) =>
    handlers.hostedReviewSitter.pushCommit(params, context)
  )
  dispatcher.onRequest('git.hostedReviewBranchUpdate', (params, context) =>
    handlers.hostedReviewSitter.updateBranch(params, context)
  )
}
