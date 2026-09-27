import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES } from '../../../../../shared/fork-session-handoff/handoff-settings-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  resolveHandoffTarget: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/fork-session-handoff/handoff-target-resolution', () => ({
  resolveHandoffTarget: mocks.resolveHandoffTarget
}))

import { preserveHandoffDraft, clearHandoffDraft } from './handoff-draft-preservation'
import { buildHandoffDialogOpenSeed } from './handoff-dialog-open-seed'

const identity = { sourcePaneKey: 'pane-1', vaultAgent: null, vaultSessionId: null }
const request = {
  source: { sourceAgent: 'codex', capturedText: 'context' },
  worktreeId: 'wt-a',
  workspacePath: '/repo',
  launchSource: 'sidebar'
} as AgentSessionContinuationRequest

function build(): ReturnType<typeof buildHandoffDialogOpenSeed> {
  return buildHandoffDialogOpenSeed({ draftIdentity: identity, anchorWorktreeId: 'wt-a', request })
}

describe('buildHandoffDialogOpenSeed', () => {
  beforeEach(() => {
    clearHandoffDraft(identity)
    mocks.getState.mockReset()
    mocks.resolveHandoffTarget.mockReset()
    mocks.getState.mockReturnValue({ settings: {} })
  })

  it('falls back to the source session when there is no draft and no preferences', () => {
    expect(build()).toEqual({
      targetWorktreeId: 'wt-a',
      selectedAgent: 'codex',
      includeToggles: DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
      templateId: null,
      steeringNote: '',
      previewPhase: { phase: 'attached' },
      previewBody: ''
    })
  })

  it('prefers saved preferences over the source session', () => {
    mocks.getState.mockReturnValue({
      settings: {
        forkSessionHandoff: {
          lastAgent: 'claude',
          lastTemplateId: 'debug',
          includeToggles: { repoState: false, diffBodies: true, openEditorTabs: false }
        }
      }
    })

    expect(build()).toMatchObject({
      selectedAgent: 'claude',
      templateId: 'debug',
      includeToggles: { repoState: false, diffBodies: true, openEditorTabs: false }
    })
  })

  it('prefers a preserved draft over preferences, including a detached preview', () => {
    mocks.getState.mockReturnValue({
      settings: { forkSessionHandoff: { lastAgent: 'claude', lastTemplateId: 'debug' } }
    })
    mocks.resolveHandoffTarget.mockReturnValue({ worktreeId: 'wt-b' })
    preserveHandoffDraft(identity, {
      steeringNote: 'focus on the flake',
      includeToggles: DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
      templateId: 'triage',
      selectedAgent: 'codex',
      targetWorktreeId: 'wt-b',
      preview: { phase: 'detached', editedBody: 'edited brief', staleReasons: ['controls-changed'] }
    })

    expect(build()).toMatchObject({
      targetWorktreeId: 'wt-b',
      selectedAgent: 'codex',
      templateId: 'triage',
      steeringNote: 'focus on the flake',
      previewPhase: { phase: 'detached', staleReasons: ['controls-changed'] },
      previewBody: 'edited brief'
    })
  })

  it('drops a draft target the store can no longer resolve', () => {
    mocks.resolveHandoffTarget.mockReturnValue(null)
    preserveHandoffDraft(identity, {
      steeringNote: '',
      includeToggles: DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
      templateId: null,
      selectedAgent: null,
      targetWorktreeId: 'wt-gone',
      preview: { phase: 'attached' }
    })

    expect(build().targetWorktreeId).toBe('wt-a')
  })
})
