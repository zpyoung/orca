// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { HandoffBriefInputs } from '@/lib/fork-session-handoff/handoff-brief-composer'
import type { HandoffTargetResolution } from '@/lib/fork-session-handoff/handoff-target-resolution'

const mocks = vi.hoisted(() => ({
  launchForkSessionHandoff: vi.fn()
}))

vi.mock('@/lib/fork-session-handoff/launch-session-handoff', () => ({
  launchForkSessionHandoff: mocks.launchForkSessionHandoff
}))

import { useHandoffDialogStart } from './use-handoff-dialog-start'

type HookArgs = Parameters<typeof useHandoffDialogStart>[0]

const request: AgentSessionContinuationRequest = {
  source: { sourceAgent: 'codex', capturedText: 'context' },
  worktreeId: 'wt-source',
  workspacePath: '/repo',
  launchSource: 'sidebar'
}

const target: HandoffTargetResolution = {
  worktreeId: 'wt-target',
  workspacePath: '/repo-target',
  initialCwd: '/repo-target',
  sshConnectionId: null,
  runtimeEnvironmentId: null,
  isFolderWorkspace: false
}

const compositionInputs: HandoffBriefInputs = {
  source: request.source,
  contextMode: 'focused',
  transcriptUsableOnTarget: false,
  inlinedCapture: 'context',
  repoState: null,
  openEditorTabs: null,
  template: null,
  steeringNote: '',
  externalContextBlock: null
}

function makeArgs(overrides: Partial<HookArgs> = {}): HookArgs {
  return {
    request,
    forkSource: undefined,
    selectedAgent: 'codex',
    target,
    compositionInputs,
    previewPhase: { phase: 'attached' },
    previewBody: 'handoff brief',
    previewedBody: 'handoff brief',
    startDisabled: false,
    createMode: false,
    anchorWorktreeId: 'wt-source',
    createName: '',
    createBaseBranch: '',
    relationship: 'continues',
    providerSessionId: null,
    draftIdentity: { sourcePaneKey: null, vaultAgent: null, vaultSessionId: null },
    includeToggles: { repoState: false, diffBodies: false, openEditorTabs: false },
    selectedTemplateId: null,
    launchedRef: { current: false },
    setTargetWorktreeId: vi.fn(),
    setCreateMode: vi.fn(),
    markTargetChanged: vi.fn(),
    setCapturedText: vi.fn(),
    setOperationError: vi.fn(),
    setStarting: vi.fn(),
    ...overrides
  }
}

const missingRequiredInputs = [
  { field: 'request', overrides: { request: null } },
  { field: 'selectedAgent', overrides: { selectedAgent: null } },
  { field: 'target', overrides: { target: null } },
  { field: 'compositionInputs', overrides: { compositionInputs: null } }
] satisfies readonly { field: string; overrides: Partial<HookArgs> }[]

describe('useHandoffDialogStart required inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(missingRequiredInputs)(
    'reports a failure without starting when $field is missing',
    async ({ overrides }) => {
      const setOperationError = vi.fn()
      const setStarting = vi.fn()
      const args = makeArgs({ ...overrides, setOperationError, setStarting })
      const hook = renderHook(() => useHandoffDialogStart(args))

      await expect(hook.result.current()).resolves.toBe(false)

      expect(setOperationError).toHaveBeenCalledTimes(1)
      expect(setOperationError).toHaveBeenCalledWith(expect.stringMatching(/\S/))
      expect(setStarting).not.toHaveBeenCalled()
      expect(mocks.launchForkSessionHandoff).not.toHaveBeenCalled()
    }
  )

  it('keeps the disabled guard silent even when required inputs are missing', async () => {
    const setOperationError = vi.fn()
    const setStarting = vi.fn()
    const args = makeArgs({
      startDisabled: true,
      request: null,
      selectedAgent: null,
      target: null,
      compositionInputs: null,
      setOperationError,
      setStarting
    })
    const hook = renderHook(() => useHandoffDialogStart(args))

    await expect(hook.result.current()).resolves.toBe(false)

    expect(setOperationError).not.toHaveBeenCalled()
    expect(setStarting).not.toHaveBeenCalled()
    expect(mocks.launchForkSessionHandoff).not.toHaveBeenCalled()
  })
})
