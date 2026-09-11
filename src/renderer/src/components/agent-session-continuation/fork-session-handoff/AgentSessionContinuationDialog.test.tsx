// @vitest-environment happy-dom

import { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}))

vi.mock('./use-handoff-dialog-state', () => ({
  useHandoffDialogState: () => mocks.state
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))
vi.mock('./HandoffDestinationControls', () => ({
  HandoffDestinationControls: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="destination" data-disabled={disabled ? 'true' : 'false'} />
  )
}))
vi.mock('./HandoffContentControls', () => ({ HandoffContentControls: () => null }))
vi.mock('./HandoffNotesControls', () => ({ HandoffNotesControls: () => null }))
vi.mock('./HandoffPreviewEditor', () => ({
  getHandoffPreviewEditorRoot: () => null,
  HandoffPreviewEditor: ({
    detached,
    onRegenerate
  }: {
    detached: boolean
    onRegenerate: () => void
  }) => (
    <div data-testid="preview" data-detached={detached ? 'true' : 'false'}>
      {detached ? <button onClick={onRegenerate}>Regenerate from controls</button> : null}
    </div>
  )
}))
vi.mock('./HandoffWarningsBanner', () => ({
  HandoffWarningsBanner: ({
    waitingForIdle,
    warnings
  }: {
    waitingForIdle: boolean
    warnings: unknown[]
  }) => (
    <div data-testid="warnings" data-waiting={waitingForIdle ? 'true' : 'false'}>
      {warnings.length}
    </div>
  )
}))

import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

const request: AgentSessionContinuationRequest = {
  source: { sourceAgent: 'codex', capturedText: 'context' },
  worktreeId: 'wt-1',
  workspacePath: '/repo',
  launchSource: 'sidebar'
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targets: [],
    targetWorktreeId: 'wt-1',
    targetPath: '/repo',
    selectTarget: vi.fn(),
    createMode: false,
    setCreateMode: vi.fn(),
    canCreateWorktree: false,
    createName: '',
    setCreateName: vi.fn(),
    createBaseBranch: '',
    setCreateBaseBranch: vi.fn(),
    relationship: 'continues',
    setRelationship: vi.fn(),
    agents: [],
    selectedAgent: 'codex',
    selectAgent: vi.fn(),
    detectingAgents: false,
    agentDetectionFailed: false,
    contextMode: 'focused',
    setContextMode: vi.fn(),
    contextControlDisabled: false,
    contextDisabledReason: null,
    includeToggles: { repoState: true, diffBodies: false, openEditorTabs: true },
    setIncludeToggles: vi.fn(),
    repoStateLoading: false,
    templates: [],
    selectedTemplateId: null,
    setSelectedTemplateId: vi.fn(),
    steeringNote: '',
    setSteeringNote: vi.fn(),
    previewBody: 'brief',
    editPreview: vi.fn(),
    regeneratePreview: vi.fn(),
    previewDetached: false,
    safetyBlock: 'locked',
    charCount: 10,
    tokenEstimate: 3,
    secretHits: [],
    warnings: [],
    waitingForIdle: false,
    waitForIdle: vi.fn(),
    captureAnyway: vi.fn(),
    starting: false,
    startDisabled: false,
    dismiss: vi.fn(),
    start: vi.fn().mockResolvedValue(true),
    ...overrides
  }
}

describe('fork session handoff dialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows detached state and keeps Start enabled while waiting for idle', async () => {
    mocks.state = state({
      previewDetached: true,
      waitingForIdle: true,
      warnings: [{ kind: 'source-busy' }]
    })

    await act(async () =>
      root.render(<AgentSessionContinuationDialog open request={request} onOpenChange={vi.fn()} />)
    )

    expect(
      container.querySelector('[data-testid="destination"]')?.getAttribute('data-disabled')
    ).toBe('true')
    expect(container.textContent).toContain('Regenerate from controls')
    expect(container.querySelector('[data-testid="warnings"]')?.getAttribute('data-waiting')).toBe(
      'true'
    )
    const startButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Start New Session')
    )
    expect(startButton?.disabled).toBe(false)
  })

  it('links the mobile preview disclosure to its region', async () => {
    mocks.state = state()
    await act(async () =>
      root.render(<AgentSessionContinuationDialog open request={request} onOpenChange={vi.fn()} />)
    )

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="handoff-brief-preview-panel"]'
    )
    const panel = container.querySelector('#handoff-brief-preview-panel')
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(panel?.getAttribute('role')).toBe('region')
    expect(panel?.getAttribute('aria-label')).toBe('Brief preview')

    await act(async () => trigger?.click())
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(panel?.classList.contains('hidden')).toBe(true)
  })

  it('explains missing live-pane controls and closes only after launch success', async () => {
    const onOpenChange = vi.fn()
    mocks.state = state()
    await act(async () =>
      root.render(
        <AgentSessionContinuationDialog open request={request} onOpenChange={onOpenChange} />
      )
    )

    expect(container.textContent).toContain('This source has no live pane')
    const startButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Start New Session')
    )
    await act(async () => startButton?.click())
    expect(mocks.state.start).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
