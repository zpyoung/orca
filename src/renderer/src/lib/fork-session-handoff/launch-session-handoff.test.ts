import { afterEach, describe, expect, it, vi } from 'vitest'
import type { useAppStore } from '@/store'
import type { LaunchAgentInNewTabResult } from '@/lib/launch-agent-in-new-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { ForkSessionHandoffLineageRecord } from '../../../../shared/fork-session-handoff/session-lineage-types'
import {
  clearRetainedHandoffBrief,
  getRetainedHandoffBrief,
  launchForkSessionHandoff,
  resendRetainedHandoffBrief,
  type LaunchForkSessionHandoffArgs,
  type LaunchForkSessionHandoffCollaborators
} from './launch-session-handoff'

const TAB_ID = 'child-tab'
const CHILD_PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const LAUNCHED_AT = 20_000
const launchArgs: LaunchForkSessionHandoffArgs = {
  agent: 'codex',
  briefText: 'Prepared handoff brief',
  target: {
    worktreeId: 'worktree-2',
    workspacePath: '/repo/worktree-2',
    initialCwd: '/repo/worktree-2/packages/app',
    sshConnectionId: null,
    runtimeEnvironmentId: null,
    isFolderWorkspace: false
  },
  groupId: 'source-group',
  launchSource: 'sidebar',
  lineage: {
    relationship: 'reviews',
    parent: {
      paneKey: 'source-tab:22222222-2222-4222-8222-222222222222',
      agent: 'claude',
      providerSessionId: 'parent-session',
      transcriptPath: '/repo/transcript.jsonl',
      worktreeId: 'worktree-1',
      title: 'Source agent'
    }
  }
}

type StoreState = ReturnType<typeof useAppStore.getState>

function storeState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    settings: {},
    ptyIdsByTabId: { [TAB_ID]: ['pty-child'] },
    agentStatusByPaneKey: {},
    tabsByWorktree: {
      'worktree-2': [
        {
          id: TAB_ID,
          ptyId: 'pty-child',
          worktreeId: 'worktree-2',
          title: 'Codex ready',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: LAUNCHED_AT
        }
      ]
    },
    runtimePaneTitlesByTabId: {},
    ...overrides
  } as StoreState
}

function launchResult(
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
): LaunchAgentInNewTabResult {
  return {
    tabId: TAB_ID,
    startupPlan: {},
    pasteDraftAfterLaunch: true,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  } as NonNullable<LaunchAgentInNewTabResult>
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function baseCollaborators(
  overrides: LaunchForkSessionHandoffCollaborators = {}
): LaunchForkSessionHandoffCollaborators {
  const state = storeState()
  return {
    getState: () => state,
    subscribeToStore: () => () => undefined,
    detectAgents: async () => ['codex'],
    isAgentEnabled: () => true,
    markAgentTrusted: async () => undefined,
    launchAgent: () => launchResult(Promise.resolve({ delivered: true, failureNotified: false })),
    submitPrompt: async () => true,
    resolveDeliveryEvidence: ({ deliveryReported }) =>
      deliveryReported ? 'delivered' : 'unobservable',
    recordLineage: async () => undefined,
    enrichLineage: async () => undefined,
    clearDraft: () => false,
    now: () => LAUNCHED_AT,
    createLineageId: () => 'lineage-1',
    ...overrides
  }
}

afterEach(() => {
  clearRetainedHandoffBrief(TAB_ID)
})

describe('launchForkSessionHandoff', () => {
  it('rechecks availability before trust and launches with the hardened prompt path', async () => {
    const events: string[] = []
    const delivery = deferred<{ delivered: boolean; failureNotified: boolean }>()
    const launchAgent = vi.fn(() => {
      events.push('launch')
      return launchResult(delivery.promise)
    })
    const recordLineage = vi.fn(async (_record: ForkSessionHandoffLineageRecord) => undefined)
    const clearDraft = vi.fn(() => true)

    const result = await launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        isAgentEnabled: () => {
          events.push('enabled')
          return true
        },
        detectAgents: async () => {
          events.push('detect')
          return ['codex']
        },
        markAgentTrusted: async () => {
          events.push('trust')
        },
        launchAgent,
        recordLineage,
        clearDraft
      })
    )

    expect(result.ok).toBe(true)
    expect(events).toEqual(['enabled', 'detect', 'trust', 'launch'])
    expect(launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'worktree-2',
        groupId: 'source-group',
        prompt: launchArgs.briefText,
        promptDelivery: 'submit-after-ready',
        initialCwd: launchArgs.target.initialCwd,
        launchSource: 'sidebar',
        onPromptDelivered: expect.any(Function)
      })
    )
    expect(clearDraft).toHaveBeenCalledWith({
      sourcePaneKey: launchArgs.lineage.parent.paneKey,
      vaultAgent: 'claude',
      vaultSessionId: 'parent-session'
    })
    expect(recordLineage).toHaveBeenCalledWith({
      id: 'lineage-1',
      createdAt: LAUNCHED_AT,
      relationship: 'reviews',
      parent: launchArgs.lineage.parent,
      child: {
        paneKey: null,
        agent: 'codex',
        providerSessionId: null,
        transcriptPath: null,
        worktreeId: 'worktree-2',
        title: null,
        tabId: TAB_ID
      }
    })
    expect(getRetainedHandoffBrief(TAB_ID)?.briefText).toBe(launchArgs.briefText)

    delivery.resolve({ delivered: true, failureNotified: false })
    if (!result.ok) {
      throw new Error('expected launch success')
    }
    await expect(result.deliveryOutcome).resolves.toBe('delivered')
    expect(getRetainedHandoffBrief(TAB_ID)).toBeNull()
  })

  it('treats the upstream delivery callback as confirmed delivery', async () => {
    const result = await launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        launchAgent: (args) => {
          args.onPromptDelivered?.()
          return launchResult()
        }
      })
    )
    if (!result.ok) {
      throw new Error('expected launch success')
    }

    await expect(result.deliveryOutcome).resolves.toBe('delivered')
    expect(getRetainedHandoffBrief(TAB_ID)).toBeNull()
  })

  it('returns an unobservable paired-host delivery with resend unavailable', async () => {
    const submitPrompt = vi.fn(async () => true)
    const recordLineage = vi.fn(async (_record: ForkSessionHandoffLineageRecord) => undefined)
    const pairedResult = {
      tabId: null,
      startupPlan: {},
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    } as NonNullable<LaunchAgentInNewTabResult>
    const result = await launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        launchAgent: () => pairedResult,
        resolveDeliveryEvidence: () => 'unobservable',
        submitPrompt,
        recordLineage
      })
    )
    if (!result.ok) {
      throw new Error('expected launch success')
    }

    expect(result.tabId).toBeNull()
    await expect(result.deliveryOutcome).resolves.toBe('unobservable')
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(recordLineage).toHaveBeenCalledWith(
      expect.objectContaining({ child: expect.objectContaining({ tabId: null }) })
    )
  })

  it('keeps the dialog intact when paired-host creation reports failure', async () => {
    const creation = deferred<{ delivered: boolean; failureNotified: boolean }>()
    const launchStarted = deferred<void>()
    const clearDraft = vi.fn(() => true)
    const recordLineage = vi.fn(async (_record: ForkSessionHandoffLineageRecord) => undefined)
    const resolveDeliveryEvidence = vi.fn(() => 'unobservable' as const)
    const pairedResult = {
      tabId: null,
      startupPlan: {},
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: creation.promise
    } as NonNullable<LaunchAgentInNewTabResult>

    const pendingResult = launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        launchAgent: () => {
          launchStarted.resolve()
          return pairedResult
        },
        clearDraft,
        recordLineage,
        resolveDeliveryEvidence
      })
    )
    await launchStarted.promise

    expect(clearDraft).not.toHaveBeenCalled()
    expect(recordLineage).not.toHaveBeenCalled()
    creation.resolve({ delivered: false, failureNotified: true })

    await expect(pendingResult).resolves.toEqual({ ok: false, reason: 'launch-failed' })
    expect(clearDraft).not.toHaveBeenCalled()
    expect(recordLineage).not.toHaveBeenCalled()
    expect(resolveDeliveryEvidence).not.toHaveBeenCalled()
  })

  it('returns unavailable without trust or launch when detection no longer finds the agent', async () => {
    const markAgentTrusted = vi.fn(async () => undefined)
    const launchAgent = vi.fn(() => launchResult())

    await expect(
      launchForkSessionHandoff(
        launchArgs,
        baseCollaborators({ detectAgents: async () => [], markAgentTrusted, launchAgent })
      )
    ).resolves.toEqual({ ok: false, reason: 'agent-unavailable' })
    expect(markAgentTrusted).not.toHaveBeenCalled()
    expect(launchAgent).not.toHaveBeenCalled()
  })

  it('keeps dialog-owned state intact when launch fails', async () => {
    const clearDraft = vi.fn(() => true)
    const recordLineage = vi.fn(async () => undefined)

    await expect(
      launchForkSessionHandoff(
        launchArgs,
        baseCollaborators({ launchAgent: () => null, clearDraft, recordLineage })
      )
    ).resolves.toEqual({ ok: false, reason: 'launch-failed' })
    expect(clearDraft).not.toHaveBeenCalled()
    expect(recordLineage).not.toHaveBeenCalled()
  })

  it('automatically resends once only after positive not-delivered evidence', async () => {
    const submitPrompt = vi.fn(async () => false)
    const result = await launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        launchAgent: () =>
          launchResult(Promise.resolve({ delivered: false, failureNotified: false })),
        resolveDeliveryEvidence: () => 'not-delivered',
        submitPrompt
      })
    )
    if (!result.ok) {
      throw new Error('expected launch success')
    }

    await expect(result.deliveryOutcome).resolves.toBe('not-delivered')
    expect(submitPrompt).toHaveBeenCalledTimes(1)
    expect(submitPrompt).toHaveBeenCalledWith({
      tabId: TAB_ID,
      ptyId: 'pty-child',
      content: launchArgs.briefText
    })
    expect(getRetainedHandoffBrief(TAB_ID)?.automaticResendAttempted).toBe(true)
    await expect(
      resendRetainedHandoffBrief(TAB_ID, {
        automatic: true,
        getState: baseCollaborators().getState,
        submitPrompt
      })
    ).resolves.toBe('already-attempted')
    expect(submitPrompt).toHaveBeenCalledTimes(1)
  })

  it('retains an unobservable delivery for manual resend without retrying automatically', async () => {
    const submitPrompt = vi.fn(async () => true)
    const getState = () => storeState()
    const result = await launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        getState,
        launchAgent: () =>
          launchResult(Promise.resolve({ delivered: false, failureNotified: false })),
        resolveDeliveryEvidence: () => 'unobservable',
        submitPrompt
      })
    )
    if (!result.ok) {
      throw new Error('expected launch success')
    }

    await expect(result.deliveryOutcome).resolves.toBe('unobservable')
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(getRetainedHandoffBrief(TAB_ID)?.briefText).toBe(launchArgs.briefText)

    await expect(resendRetainedHandoffBrief(TAB_ID, { getState, submitPrompt })).resolves.toBe(
      'resent'
    )
    expect(submitPrompt).toHaveBeenCalledTimes(1)
    expect(getRetainedHandoffBrief(TAB_ID)).toBeNull()
  })

  it('enriches child lineage when the launched tab first reports a provider session', async () => {
    let state = storeState()
    let listener: ((state: StoreState) => void) | null = null
    const enrichLineage = vi.fn(async () => undefined)
    const result = await launchForkSessionHandoff(
      launchArgs,
      baseCollaborators({
        getState: () => state,
        subscribeToStore: (nextListener) => {
          listener = nextListener
          return () => {
            listener = null
          }
        },
        enrichLineage
      })
    )
    expect(result.ok).toBe(true)

    const childEntry = {
      state: 'done',
      prompt: '',
      updatedAt: LAUNCHED_AT + 1,
      stateStartedAt: LAUNCHED_AT + 1,
      paneKey: CHILD_PANE_KEY,
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'child-session' }
    } satisfies AgentStatusEntry
    state = storeState({ agentStatusByPaneKey: { [CHILD_PANE_KEY]: childEntry } })
    const notify = listener as ((state: StoreState) => void) | null
    notify?.(state)
    await Promise.resolve()

    expect(enrichLineage).toHaveBeenCalledWith({
      recordId: 'lineage-1',
      paneKey: CHILD_PANE_KEY,
      providerSessionId: 'child-session'
    })
  })
})
