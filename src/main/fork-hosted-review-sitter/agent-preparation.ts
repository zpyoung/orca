import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  buildHostedReviewAgentPrompt,
  type HostedReviewAgentLaunchInput
} from '../../shared/fork-hosted-review-sitter/agent-prompt'
import type {
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { RuntimeTerminalCreate, RuntimeTerminalWait } from '../../shared/runtime-types'
import { resolveSourceControlActionRecipe } from '../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate,
  type SourceControlLaunchActionId
} from '../../shared/source-control-ai-actions'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { getHostedReviewSitterChangedPaths } from './agent-policy'
import {
  assertBranchAndHead,
  assertCommitSha,
  assertOpaqueActionId,
  assertPolicyAllows,
  assertWriteContention,
  withHostedReviewSitterActionEffect,
  buildPreparedCommitMessage,
  throwIfAborted,
  verifyPreparedCommit,
  type PrepareAction
} from './agent-execution'
import { buildHostedReviewSitterAgentTitle } from './contention'
import {
  resolveHostedReviewSitterGitExecution,
  type HostedReviewSitterGitExecution
} from './provider-git'

const AGENT_COMPLETION_WAIT_SLICE_MS = 30_000

type PrepareSession = {
  terminal: RuntimeTerminalCreate
  stop: () => Promise<void>
  disposeAbortListener: () => void
}

function configuredAgentForAction(
  store: Store,
  definition: HostedReviewSitterDefinition,
  actionId: SourceControlLaunchActionId
) {
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
  return { agent: configured, recipe }
}

function preparePrompt(
  definition: HostedReviewSitterDefinition,
  action: PrepareAction,
  basePrompt: string,
  recipeActionId: SourceControlLaunchActionId,
  recipeTemplate: string | undefined
): string {
  const renderedBasePrompt = renderSourceControlActionCommandTemplate(
    recipeTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[recipeActionId],
    { basePrompt }
  ).trim()
  if (!renderedBasePrompt) {
    throw new Error(`Hosted review ${recipeActionId} prompt is empty.`)
  }
  return buildHostedReviewAgentPrompt({
    task: action.kind === 'prepare-fix' ? 'fix-checks' : 'resolve-conflicts',
    basePrompt: renderedBasePrompt,
    reviewUrl: definition.reviewUrl,
    expectedHeadSha: action.headSha,
    ...(action.kind === 'prepare-conflict-resolution' ? { expectedBaseSha: action.baseSha } : {}),
    unattended: true
  })
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
          'Merge the exact base commit with --no-commit, resolve only its conflicts, and leave the result staged and uncommitted.'
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

async function waitForOwnedAgentCompletion(
  runtime: OrcaRuntimeService,
  terminal: RuntimeTerminalCreate,
  signal: AbortSignal
): Promise<RuntimeTerminalWait> {
  for (;;) {
    throwIfAborted(signal)
    try {
      const result = await runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: AGENT_COMPLETION_WAIT_SLICE_MS,
        signal
      })
      if (result.blockedReason) {
        throw new Error(`Hosted review agent requires interaction: ${result.blockedReason}.`)
      }
      if (result.status !== 'running') {
        throw new Error('Hosted review agent exited before a completed idle turn was observed.')
      }
      return result
    } catch (error) {
      if (signal.aborted) {
        throwIfAborted(signal)
      }
      if (error instanceof Error && error.message === 'timeout') {
        continue
      }
      throw error
    }
  }
}

async function launchPrepareSession(
  runtime: OrcaRuntimeService,
  definition: HostedReviewSitterDefinition,
  actionId: string,
  agent: HostedReviewAgentLaunchInput['agent'],
  prompt: string,
  signal: AbortSignal
): Promise<PrepareSession> {
  let terminal: RuntimeTerminalCreate | null = null
  let stopPromise: Promise<void> | null = null
  const stop = async (): Promise<void> => {
    if (!terminal) {
      return
    }
    stopPromise ??= runtime.closeTerminal(terminal.handle).then((result) => {
      if (!result.ptyKilled) {
        throw new Error(
          `Hosted review agent stop was not verified${result.ptyStopReason ? `: ${result.ptyStopReason}` : '.'}`
        )
      }
    })
    await stopPromise
  }
  const onAbort = (): void => {
    void stop().catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    throwIfAborted(signal)
    terminal = await runtime.launchAgentTerminal(`id:${definition.worktreeId}`, {
      agent,
      prompt,
      title: buildHostedReviewSitterAgentTitle(definition.id, actionId)
    })
    if (signal.aborted) {
      await stop()
      throwIfAborted(signal)
    }
    return {
      terminal,
      stop,
      disposeAbortListener: () => signal.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    signal.removeEventListener('abort', onAbort)
    throw error
  }
}

async function readWorkingPolicyEvidence(
  git: HostedReviewSitterGitExecution,
  signal: AbortSignal
): Promise<{ status: GitStatusResult; patch: string }> {
  const [status, patchResult] = await Promise.all([
    git.getStatus(signal),
    git.exec(['diff', '--no-ext-diff', '--unified=0', 'HEAD', '--'], signal)
  ])
  return { status, patch: patchResult.stdout }
}
async function assertRemoteSourceHead(
  git: HostedReviewSitterGitExecution,
  expectedHeadSha: string,
  signal: AbortSignal
): Promise<void> {
  const remoteHeadSha = await git.remoteHeadSha(signal)
  if (remoteHeadSha !== expectedHeadSha) {
    throw new Error(
      `Hosted review source head changed from ${expectedHeadSha} to ${remoteHeadSha || '<unverifiable>'}.`
    )
  }
}
async function preparePreflight(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  action: PrepareAction,
  actionId: string,
  signal: AbortSignal
) {
  assertOpaqueActionId(actionId)
  assertCommitSha(action.headSha, 'expected head')
  if (action.kind === 'prepare-conflict-resolution') {
    assertCommitSha(action.baseSha, 'expected base')
  }
  const git = resolveHostedReviewSitterGitExecution(runtime, store, definition)
  await assertWriteContention(runtime, store, definition)
  await assertBranchAndHead(git, definition, action.headSha, signal)
  throwIfAborted(signal)
  await assertWriteContention(runtime, store, definition)

  const recipeActionId =
    action.kind === 'prepare-fix' ? ('fixChecks' as const) : ('resolveConflicts' as const)
  const { agent, recipe } = configuredAgentForAction(store, definition, recipeActionId)
  runtime.validateOrchestrationAgentLauncher(agent)
  const prompt = preparePrompt(
    definition,
    action,
    basePromptForAction(definition, action),
    recipeActionId,
    recipe.commandInputTemplate
  )
  return { git, agent, prompt }
}

export async function prepareWithHostedReviewSitterAgent(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  action: PrepareAction,
  actionId: string,
  signal: AbortSignal
): Promise<HostedReviewSitterActionResult> {
  const { git, agent, prompt } = await preparePreflight(
    runtime,
    store,
    definition,
    action,
    actionId,
    signal
  ).catch((error: unknown) => {
    throw withHostedReviewSitterActionEffect(error, 'none')
  })
  // Crossing this call can create a live writer even if its response is lost. Every failure from
  // here onward therefore remains unknown unless a later verified success is recorded.
  const session = await launchPrepareSession(runtime, definition, actionId, agent, prompt, signal)
  let committed = false
  try {
    await waitForOwnedAgentCompletion(runtime, session.terminal, signal)
    await assertWriteContention(runtime, store, definition, actionId, {
      requireOwnSession: true,
      requireOwnIdle: true
    })
    // Freeze the exact sitter-owned terminal before reading or staging its result. An idle TUI is
    // still interactive; leaving it alive would let user input mutate the index after inspection.
    await session.stop()
    throwIfAborted(signal)
    await assertWriteContention(runtime, store, definition, actionId, {
      allowDirtyAfterOwnedSessionStopped: true
    })
    await assertBranchAndHead(git, definition, action.headSha, signal)
    await assertRemoteSourceHead(git, action.headSha, signal)
    const firstEvidence = await readWorkingPolicyEvidence(git, signal)
    if (firstEvidence.status.entries.length === 0) {
      throw new Error('Hosted review agent completed without preparing a Git change.')
    }
    assertPolicyAllows(firstEvidence.status, firstEvidence.patch)

    const paths = getHostedReviewSitterChangedPaths(firstEvidence.status)
    throwIfAborted(signal)
    await assertWriteContention(runtime, store, definition, actionId, {
      allowDirtyAfterOwnedSessionStopped: true
    })
    await assertBranchAndHead(git, definition, action.headSha, signal)
    await assertRemoteSourceHead(git, action.headSha, signal)
    await git.stageFiles(paths, signal)

    await assertWriteContention(runtime, store, definition, actionId, {
      allowDirtyAfterOwnedSessionStopped: true
    })
    const finalEvidence = await readWorkingPolicyEvidence(git, signal)
    assertPolicyAllows(finalEvidence.status, finalEvidence.patch)
    throwIfAborted(signal)
    await assertWriteContention(runtime, store, definition, actionId, {
      allowDirtyAfterOwnedSessionStopped: true
    })
    await assertBranchAndHead(git, definition, action.headSha, signal)
    await assertRemoteSourceHead(git, action.headSha, signal)
    const commitResult = await git.commit(buildPreparedCommitMessage(action, actionId), signal)
    if (!commitResult.success) {
      throw new Error(
        `Failed to commit hosted review preparation: ${commitResult.error ?? 'unknown error'}`
      )
    }
    committed = true

    const preparedCommitSha = await git.currentHeadSha(signal)
    await verifyPreparedCommit(git, action, actionId, preparedCommitSha, signal)
    const postCommitStatus = await git.getStatus(signal)
    if (postCommitStatus.didHitLimit || postCommitStatus.entries.length > 0) {
      throw new Error('Prepared commit did not leave an exactly clean worktree.')
    }
    return { kind: 'prepared', preparedCommitSha }
  } catch (error) {
    try {
      await session.stop()
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        committed
          ? 'Hosted review preparation committed but its agent stop was unverifiable.'
          : 'Hosted review preparation failed and its agent stop was unverifiable.'
      )
    }
    throw error
  } finally {
    session.disposeAbortListener()
  }
}
