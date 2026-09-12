import type { Store } from '../persistence'
import { sanitizeWorktreeDisplayName } from '../ipc/worktree-display-name'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  buildHostedReviewAgentPrompt,
  type HostedReviewAgentLaunchInput,
  type HostedReviewAgentLaunchResult
} from '../../shared/fork-hosted-review-sitter/agent-prompt'
import type {
  ActionLedgerEntry,
  HostedReviewSitterAction,
  HostedReviewSitterActionResult,
  HostedReviewSitterContention,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import { prepareWithHostedReviewSitterAgent } from './agent-preparation'
import { publishHostedReviewSitterPreparation } from './agent-publication'
import {
  recoverHostedReviewSitterAgentPreparation,
  type HostedReviewSitterPreparationRecovery
} from './agent-recovery'
import { inspectHostedReviewSitterContention } from './contention'

export { recoverHostedReviewSitterAgentPreparation }

export type HostedReviewSitterAgentActuator = {
  contention(
    definition: HostedReviewSitterDefinition,
    ownActionId?: string
  ): Promise<HostedReviewSitterContention>
  recover(
    definition: HostedReviewSitterDefinition,
    interrupted: ActionLedgerEntry
  ): Promise<HostedReviewSitterPreparationRecovery>
  execute(
    definition: HostedReviewSitterDefinition,
    action: HostedReviewSitterAction,
    options: { actionId: string; signal: AbortSignal }
  ): Promise<HostedReviewSitterActionResult>
}

export function createHostedReviewSitterAgentActuator(
  runtime: OrcaRuntimeService,
  store: Store
): HostedReviewSitterAgentActuator {
  return {
    contention: (definition, ownActionId) =>
      inspectHostedReviewSitterContention(runtime, store, definition, ownActionId),
    recover: (definition, interrupted) =>
      recoverHostedReviewSitterAgentPreparation(runtime, store, definition, interrupted),
    execute: async (definition, action, options) => {
      if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
        return prepareWithHostedReviewSitterAgent(
          runtime,
          store,
          definition,
          action,
          options.actionId,
          options.signal
        )
      }
      if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
        return publishHostedReviewSitterPreparation(
          runtime,
          store,
          definition,
          action,
          options.actionId,
          options.signal
        )
      }
      throw new Error(`Hosted review agent actuator cannot execute ${action.kind}.`)
    }
  }
}

/** Main-process entry shared by every manual "Fix Broken Checks" surface. */
export async function launchHostedReviewSitterFixAgent(
  runtime: OrcaRuntimeService,
  store: Store,
  input: HostedReviewAgentLaunchInput
): Promise<HostedReviewAgentLaunchResult> {
  if (!store.getRepo(input.repoId) || !input.worktreeId) {
    throw new Error('An explicit repository and workspace are required to launch a checks agent.')
  }
  if (!input.basePrompt.trim()) {
    throw new Error('Fix checks prompt is empty.')
  }
  const workspace = await runtime.showManagedWorktree(`id:${input.worktreeId}`)
  if (workspace.repoId !== input.repoId) {
    throw new Error('The selected workspace does not belong to the explicit repository.')
  }
  runtime.validateOrchestrationAgentLauncher(input.agent)
  const prompt = buildHostedReviewAgentPrompt({
    task: 'fix-checks',
    basePrompt: input.basePrompt,
    unattended: false
  })
  const terminal = await runtime.launchAgentTerminal(`id:${input.worktreeId}`, {
    agent: input.agent,
    prompt,
    title: sanitizeWorktreeDisplayName(input.title ?? '') ?? 'Fix broken hosted review checks'
  })
  return { handle: terminal.handle, worktreeId: terminal.worktreeId }
}
