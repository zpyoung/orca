import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type {
  HostedReviewSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import {
  resolveHostedReviewSitterGitExecution,
  throwIfAborted,
  type HostedReviewSitterGitExecution
} from './provider-git'
import { executeGitHubSitterAction, readGitHubSitterSnapshot } from './provider-github'
import { executeGitLabSitterAction, readGitLabSitterSnapshot } from './provider-gitlab'
import {
  createHostedReviewSitterMutationTracker,
  tagHostedReviewPreDispatchError
} from './provider-action-effect'

export type HostedReviewSitterProviderAdapter = {
  read(
    definition: HostedReviewSitterDefinition,
    options: { fresh: boolean }
  ): Promise<HostedReviewSnapshot>
  execute(
    definition: HostedReviewSitterDefinition,
    action: HostedReviewSitterAction,
    signal?: AbortSignal
  ): Promise<HostedReviewSitterActionResult>
}

const PROVIDER_ACTIONS: Partial<Record<HostedReviewSitterAction['kind'], true>> = {
  'rerun-check': true,
  'update-branch': true,
  merge: true,
  enqueue: true
}

function assertProviderAction(
  action: HostedReviewSitterAction
): asserts action is Extract<
  HostedReviewSitterAction,
  { kind: 'rerun-check' | 'update-branch' | 'merge' | 'enqueue' }
> {
  if (PROVIDER_ACTIONS[action.kind] !== true) {
    throw new Error(`Hosted review sitter action ${action.kind} belongs to the agent actuator.`)
  }
}

export function createHostedReviewSitterProvider(
  runtime: OrcaRuntimeService,
  store: Store
): HostedReviewSitterProviderAdapter {
  return {
    read: async (definition, options) => {
      const git = resolveHostedReviewSitterGitExecution(runtime, store, definition)
      switch (definition.provider) {
        case 'github':
          return readGitHubSitterSnapshot(definition, git, options)
        case 'gitlab':
          return readGitLabSitterSnapshot(definition, git, options)
      }
    },
    execute: async (definition, action, signal) => {
      const tracker = createHostedReviewSitterMutationTracker()
      try {
        throwIfAborted(signal)
        assertProviderAction(action)
        const git = resolveHostedReviewSitterGitExecution(runtime, store, definition)
        switch (definition.provider) {
          case 'github':
            return await executeGitHubSitterAction(definition, action, git, signal, tracker)
          case 'gitlab':
            return await executeGitLabSitterAction(definition, action, git, signal, tracker)
        }
      } catch (error) {
        throw tracker.dispatched ? error : tagHostedReviewPreDispatchError(error)
      }
    }
  }
}

export { resolveHostedReviewSitterGitExecution }
export type { HostedReviewSitterGitExecution }
