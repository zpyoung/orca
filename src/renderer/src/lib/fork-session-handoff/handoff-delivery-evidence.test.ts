import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  resolveHandoffDeliveryEvidence,
  type HandoffDeliveryEvidenceState
} from './handoff-delivery-evidence'

const TAB_ID = 'tab-1'
const PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const LAUNCHED_AT = 10_000
const OBSERVED_AT = 12_000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: OBSERVED_AT,
    stateStartedAt: 9_000,
    paneKey: PANE_KEY,
    stateHistory: [],
    ...overrides
  }
}

function state(
  args: {
    entry?: AgentStatusEntry
    title?: string
    hasLivePty?: boolean
  } = {}
): HandoffDeliveryEvidenceState {
  return {
    agentStatusByPaneKey: args.entry ? { [PANE_KEY]: args.entry } : {},
    ptyIdsByTabId: { [TAB_ID]: args.hasLivePty === false ? [] : ['pty-1'] },
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {
      'worktree-1': [
        {
          id: TAB_ID,
          ptyId: args.hasLivePty === false ? null : 'pty-1',
          worktreeId: 'worktree-1',
          title: args.title ?? 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: LAUNCHED_AT
        }
      ]
    }
  } as HandoffDeliveryEvidenceState
}

describe('resolveHandoffDeliveryEvidence', () => {
  it('accepts an upstream successful-delivery report without a local tab', () => {
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: null,
        launchedAtMs: LAUNCHED_AT,
        deliveryReported: true,
        state: state(),
        observedAtMs: OBSERVED_AT
      })
    ).toBe('delivered')
  })

  it('detects a new turn from the current working transition', () => {
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: TAB_ID,
        launchedAtMs: LAUNCHED_AT,
        state: state({
          entry: entry({ state: 'working', stateStartedAt: LAUNCHED_AT + 1 })
        }),
        observedAtMs: OBSERVED_AT
      })
    ).toBe('delivered')
  })

  it('detects a new turn retained in state history', () => {
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: TAB_ID,
        launchedAtMs: LAUNCHED_AT,
        deliveryReported: false,
        state: state({
          entry: entry({
            stateHistory: [{ state: 'working', prompt: 'handoff', startedAt: LAUNCHED_AT + 1 }]
          })
        }),
        observedAtMs: OBSERVED_AT
      })
    ).toBe('delivered')
  })

  it('requires a failed report before idle hook evidence means not delivered', () => {
    const idleState = state({ entry: entry() })

    expect(
      resolveHandoffDeliveryEvidence({
        tabId: TAB_ID,
        launchedAtMs: LAUNCHED_AT,
        state: idleState,
        observedAtMs: OBSERVED_AT
      })
    ).toBe('unobservable')
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: TAB_ID,
        launchedAtMs: LAUNCHED_AT,
        deliveryReported: false,
        state: idleState,
        observedAtMs: OBSERVED_AT
      })
    ).toBe('not-delivered')
  })

  it('treats a title turn-returned-idle sample without history as unobservable', () => {
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: TAB_ID,
        launchedAtMs: LAUNCHED_AT,
        deliveryReported: false,
        state: state({ title: 'Claude ready' }),
        observedAtMs: OBSERVED_AT
      })
    ).toBe('unobservable')
  })

  it.each([
    ['an unrecognized title', state({ title: 'shell' })],
    ['a working title', state({ title: '⠋ running the tests' })],
    ['an idle title without a live PTY', state({ title: 'Claude ready', hasLivePty: false })]
  ])('is unobservable with %s and no hook row', (_label, evidenceState) => {
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: TAB_ID,
        launchedAtMs: LAUNCHED_AT,
        deliveryReported: false,
        state: evidenceState,
        observedAtMs: OBSERVED_AT
      })
    ).toBe('unobservable')
  })

  it('is unobservable when a paired web-host delivery fails', () => {
    expect(
      resolveHandoffDeliveryEvidence({
        tabId: null,
        launchedAtMs: LAUNCHED_AT,
        deliveryReported: false,
        state: state(),
        observedAtMs: OBSERVED_AT
      })
    ).toBe('unobservable')
  })
})
