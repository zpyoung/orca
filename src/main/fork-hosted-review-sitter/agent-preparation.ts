import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { getRepeatedFailureAfterOwnFixEvidence } from '../../shared/fork-hosted-review-sitter/stop-policy'
import {
  buildHostedReviewAgentPrompt,
  type HostedReviewAgentLaunchInput
} from '../../shared/fork-hosted-review-sitter/agent-prompt'
import type {
  HostedReviewSitterDefinition,
  HostedReviewSnapshot,
  PrepareConflictResolutionAction,
  PrepareFixAction
} from '../../shared/fork-hosted-review-sitter/types'
import { resolveSourceControlActionRecipe } from '../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate,
  type SourceControlLaunchActionId
} from '../../shared/source-control-ai-actions'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { Store } from '../persistence'

export type PrepareAction = PrepareFixAction | PrepareConflictResolutionAction
export type HostedReviewWorkerDispatch = {
  spec: string
  agent: HostedReviewAgentLaunchInput['agent']
  taskKey: string
}

function configuredAgentForAction(
  store: Store,
  definition: HostedReviewSitterDefinition,
  actionId: SourceControlLaunchActionId
): { agent: HostedReviewAgentLaunchInput['agent']; template: string | undefined } {
  const settings = store.getSettings()
  const repo = store.getRepo(definition.repoId)
  const recipe = resolveSourceControlActionRecipe({ settings, repo, actionId })
  const configured = isTuiAgent(recipe.agentId)
    ? recipe.agentId
    : isTuiAgent(settings.defaultTuiAgent)
      ? settings.defaultTuiAgent
      : null
  if (!configured || !isTuiAgentEnabled(configured, settings.disabledTuiAgents)) {
    throw new Error(`No enabled TUI agent is configured for ${actionId}.`)
  }
  return { agent: configured, template: recipe.commandInputTemplate }
}

function basePromptForAction(
  definition: HostedReviewSitterDefinition,
  action: PrepareAction
): string {
  if (action.kind === 'prepare-conflict-resolution') {
    return JSON.stringify(
      {
        reviewUrl: definition.reviewUrl,
        sourceHeadSha: action.headSha,
        baseHeadSha: action.baseSha,
        instruction:
          'Merge the exact base commit, resolve only its conflicts, verify narrowly, and commit the result locally.'
      },
      null,
      2
    )
  }
  return JSON.stringify(
    {
      reviewUrl: definition.reviewUrl,
      checkKey: action.checkKey,
      checkIds: action.checkIds,
      observationIds: action.observationIds,
      failureSignature: action.failureSignature,
      evidence: action.evidence
    },
    null,
    2
  )
}

export function buildHostedReviewWorkerDispatch(
  store: Store,
  definition: HostedReviewSitterDefinition,
  action: PrepareAction,
  preparationFingerprint: string,
  failureHistory: { review: HostedReviewSnapshot; ledger: WatcherLedger }
): HostedReviewWorkerDispatch {
  const recipeActionId =
    action.kind === 'prepare-fix' ? ('fixChecks' as const) : ('resolveConflicts' as const)
  const { agent, template } = configuredAgentForAction(store, definition, recipeActionId)
  const previousFixAttempts =
    action.kind === 'prepare-fix' && failureHistory.review.headSha === action.headSha
      ? getRepeatedFailureAfterOwnFixEvidence(
          failureHistory.review,
          failureHistory.ledger,
          definition.mergeCheckScope
        ).filter(
          (evidence) =>
            evidence.checkKey === action.checkKey &&
            evidence.failureSignature === action.failureSignature
        )
      : []
  const renderedBasePrompt = renderSourceControlActionCommandTemplate(
    template ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[recipeActionId],
    { basePrompt: basePromptForAction(definition, action) }
  ).trim()
  if (!renderedBasePrompt) {
    throw new Error(`Hosted review ${recipeActionId} prompt is empty.`)
  }
  return {
    agent,
    taskKey: action.kind,
    spec: buildHostedReviewAgentPrompt({
      task: action.kind === 'prepare-fix' ? 'fix-checks' : 'resolve-conflicts',
      basePrompt: renderedBasePrompt,
      reviewUrl: definition.reviewUrl,
      expectedHeadSha: action.headSha,
      ...(action.kind === 'prepare-conflict-resolution' ? { expectedBaseSha: action.baseSha } : {}),
      ...(previousFixAttempts.length > 0 ? { previousFixAttempts } : {}),
      unattended: true,
      preparationAttemptFingerprint: preparationFingerprint
    })
  }
}
