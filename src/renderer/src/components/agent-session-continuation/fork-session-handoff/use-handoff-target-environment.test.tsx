// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { HandoffTargetResolution } from '@/lib/fork-session-handoff/handoff-target-resolution'
import type { HandoffTranscriptProbeOutcome as TranscriptProbeOutcome } from '@/lib/fork-session-handoff/handoff-transcript-reachability'
import type { ForkSessionHandoffIncludeToggles } from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'

type DetectionResult = { agents: TuiAgent[]; selectedAgent: TuiAgent | null }

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  invalidate: vi.fn(),
  resolveTranscriptReachability: vi.fn(),
  fetchHandoffRepoState: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/lib/fork-session-handoff/handoff-target-resolution', () => ({
  createHandoffAgentDetectionGeneration: () => ({
    detect: mocks.detect,
    invalidate: mocks.invalidate
  })
}))
vi.mock('@/lib/fork-session-handoff/handoff-transcript-reachability', () => ({
  resolveTranscriptReachability: mocks.resolveTranscriptReachability
}))
vi.mock('@/lib/fork-session-handoff/handoff-repo-state', () => ({
  fetchHandoffRepoState: mocks.fetchHandoffRepoState
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

import { useHandoffTargetEnvironment } from './use-handoff-target-environment'

const OPEN_SESSION = { session: 'test' }

const request: AgentSessionContinuationRequest = {
  source: { sourceAgent: 'codex', capturedText: 'context' },
  worktreeId: 'wt-a',
  workspacePath: '/repo',
  launchSource: 'sidebar'
}

const noRepoState: ForkSessionHandoffIncludeToggles = {
  repoState: false,
  diffBodies: false,
  openEditorTabs: false
}
const ignoreTranscriptUnavailable = (): void => {}
const noTargetOverrides: Partial<HandoffTargetResolution> = {}

function target(
  worktreeId: string,
  overrides: Partial<HandoffTargetResolution> = noTargetOverrides
): HandoffTargetResolution {
  return {
    worktreeId,
    workspacePath: `/workspace/${worktreeId}`,
    initialCwd: `/workspace/${worktreeId}`,
    sshConnectionId: null,
    runtimeEnvironmentId: null,
    isFolderWorkspace: false,
    ...overrides
  }
}

function Harness({
  targetWorktreeId,
  resolvedTarget = null,
  sourceTarget = null,
  includeToggles = noRepoState,
  onTranscriptUnavailable = ignoreTranscriptUnavailable,
  openSession = OPEN_SESSION,
  seedAgent = null
}: {
  targetWorktreeId: string
  resolvedTarget?: HandoffTargetResolution | null
  sourceTarget?: HandoffTargetResolution | null
  includeToggles?: ForkSessionHandoffIncludeToggles
  onTranscriptUnavailable?: () => void
  openSession?: object | null
  seedAgent?: TuiAgent | null
}): React.JSX.Element {
  const state = useHandoffTargetEnvironment({
    open: true,
    request,
    forkSource: undefined,
    targetWorktreeId,
    target: resolvedTarget,
    sourceTarget,
    includeToggles,
    openSession,
    seedAgent,
    disabledAgents: [],
    lastAgent: undefined,
    defaultAgent: undefined,
    onTranscriptUnavailable
  })
  return (
    <div
      data-detecting={state.detectingAgents ? 'true' : 'false'}
      data-agent={state.selectedAgent ?? ''}
      data-transcript-loading={state.transcriptReachabilityLoading ? 'true' : 'false'}
      data-transcript-reachability={state.transcriptReachability}
      data-transcript-path={state.transcriptResolvedPath ?? ''}
      data-captured={state.capturedText ?? ''}
      data-repo-loading={state.repoStateLoading ? 'true' : 'false'}
    />
  )
}

describe('handoff target environment', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    mocks.detect.mockResolvedValue({ agents: ['codex'], selectedAgent: null })
    mocks.resolveTranscriptReachability.mockResolvedValue({
      verdict: 'none',
      transcriptPath: null
    })
    mocks.fetchHandoffRepoState.mockResolvedValue(null)
    mocks.getState.mockReturnValue({})
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('does not let a stale detection clear the newer loading generation', async () => {
    let resolveFirst: (result: DetectionResult) => void = () => {}
    let resolveSecond: (result: DetectionResult) => void = () => {}
    mocks.detect
      .mockReturnValueOnce(
        new Promise<DetectionResult>((resolve) => {
          resolveFirst = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise<DetectionResult>((resolve) => {
          resolveSecond = resolve
        })
      )

    await act(async () => root.render(<Harness targetWorktreeId="wt-a" />))
    act(() => root.render(<Harness targetWorktreeId="wt-b" />))
    await act(async () => resolveFirst({ agents: ['claude'], selectedAgent: null }))

    expect(container.firstElementChild?.getAttribute('data-detecting')).toBe('true')
    expect(container.firstElementChild?.getAttribute('data-agent')).toBe('')

    await act(async () => resolveSecond({ agents: ['codex'], selectedAgent: null }))
    expect(container.firstElementChild?.getAttribute('data-detecting')).toBe('false')
    expect(container.firstElementChild?.getAttribute('data-agent')).toBe('codex')
  })

  it('keeps the full transcript mode until a reachability probe rejects it', async () => {
    let resolveProbe: (outcome: TranscriptProbeOutcome) => void = () => {}
    mocks.resolveTranscriptReachability.mockReturnValueOnce(
      new Promise<TranscriptProbeOutcome>((resolve) => {
        resolveProbe = resolve
      })
    )
    const onTranscriptUnavailable = vi.fn()
    const destination = target('wt-destination')

    await act(async () =>
      root.render(
        <Harness
          targetWorktreeId={destination.worktreeId}
          resolvedTarget={destination}
          onTranscriptUnavailable={onTranscriptUnavailable}
        />
      )
    )

    expect(container.firstElementChild?.getAttribute('data-transcript-loading')).toBe('true')
    expect(onTranscriptUnavailable).not.toHaveBeenCalled()

    await act(async () =>
      resolveProbe({ verdict: 'usable', transcriptPath: '/home/ada/.claude/session.jsonl' })
    )
    expect(container.firstElementChild?.getAttribute('data-transcript-loading')).toBe('false')
    expect(container.firstElementChild?.getAttribute('data-transcript-reachability')).toBe('usable')
    expect(container.firstElementChild?.getAttribute('data-transcript-path')).toBe(
      '/home/ada/.claude/session.jsonl'
    )
    expect(onTranscriptUnavailable).not.toHaveBeenCalled()
  })

  it('forces focused context only after a non-usable verdict', async () => {
    let resolveProbe: (outcome: TranscriptProbeOutcome) => void = () => {}
    mocks.resolveTranscriptReachability.mockReturnValueOnce(
      new Promise<TranscriptProbeOutcome>((resolve) => {
        resolveProbe = resolve
      })
    )
    const onTranscriptUnavailable = vi.fn()
    const destination = target('wt-destination')

    await act(async () =>
      root.render(
        <Harness
          targetWorktreeId={destination.worktreeId}
          resolvedTarget={destination}
          onTranscriptUnavailable={onTranscriptUnavailable}
        />
      )
    )
    expect(onTranscriptUnavailable).not.toHaveBeenCalled()

    await act(async () => resolveProbe({ verdict: 'unreachable', transcriptPath: null }))
    expect(onTranscriptUnavailable).toHaveBeenCalledTimes(1)
    expect(container.firstElementChild?.getAttribute('data-transcript-loading')).toBe('false')
  })

  // An unverified transcript is as unusable as an absent one, so it must reach
  // the same bounded-capture fallback instead of leaving the brief empty.
  it.each(['unreachable', 'unverifiable'] as const)(
    'captures bounded context after a %s verdict',
    async (verdict) => {
      mocks.resolveTranscriptReachability.mockResolvedValue({ verdict, transcriptPath: null })
      const destination = target('wt-destination')

      await act(async () =>
        root.render(
          <Harness targetWorktreeId={destination.worktreeId} resolvedTarget={destination} />
        )
      )

      expect(container.firstElementChild?.getAttribute('data-transcript-reachability')).toBe(
        verdict
      )
      expect(container.firstElementChild?.getAttribute('data-captured')).toBe('context')
    }
  )

  it('fetches repository state from the source while detecting agents on the destination', async () => {
    const destination = target('wt-destination', { sshConnectionId: 'destination-host' })
    const source = target('wt-source', { sshConnectionId: 'source-host' })
    const includeToggles: ForkSessionHandoffIncludeToggles = {
      repoState: true,
      diffBodies: true,
      openEditorTabs: false
    }

    await act(async () =>
      root.render(
        <Harness
          targetWorktreeId={destination.worktreeId}
          resolvedTarget={destination}
          sourceTarget={source}
          includeToggles={includeToggles}
        />
      )
    )

    expect(mocks.detect).toHaveBeenCalledWith(destination.worktreeId, null)
    expect(mocks.fetchHandoffRepoState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {},
        target: source,
        includeDiffBodies: true
      })
    )
  })

  it('does not fetch repository state for a folder source', async () => {
    const destination = target('wt-destination')
    const source = target('folder:source', { isFolderWorkspace: true })

    await act(async () =>
      root.render(
        <Harness
          targetWorktreeId={destination.worktreeId}
          resolvedTarget={destination}
          sourceTarget={source}
          includeToggles={{ repoState: true, diffBodies: true, openEditorTabs: false }}
        />
      )
    )

    expect(mocks.fetchHandoffRepoState).not.toHaveBeenCalled()
    expect(container.firstElementChild?.getAttribute('data-repo-loading')).toBe('false')
  })
})
