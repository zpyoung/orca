// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../shared/native-chat-session-options'
import type { NativeChatPtySessionOptionsSurface } from '../native-chat-pty-session-options'

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  subscribeLocal: vi.fn(),
  subscribeRemote: vi.fn()
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: mocks.getSettings
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: (ptyId: string) => ptyId.startsWith('remote:')
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  subscribeToRuntimeTerminalData: mocks.subscribeRemote
}))

vi.mock('../../terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mocks.subscribeLocal
}))

import { useClaudeStartupFrameRevision } from './use-claude-startup-frame-revision'

const UNRESOLVED_MODEL: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: { type: 'select', choices: [] },
  valueSource: 'unknown',
  settable: true
}

const RESOLVED_MODEL: SessionOptionDescriptor = {
  ...UNRESOLVED_MODEL,
  kind: { type: 'select', currentValue: 'opus', choices: [] },
  valueSource: 'reported'
}

function createSurface(): {
  surface: NativeChatPtySessionOptionsSurface
  resolveModel(): void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let snapshot = [UNRESOLVED_MODEL]
  const listeners = new Set<(snapshot: SessionOptionDescriptor[]) => void>()
  const unsubscribe = vi.fn()
  const surface = {
    getSnapshot: () => snapshot,
    subscribe: (listener: (value: SessionOptionDescriptor[]) => void) => {
      listeners.add(listener)
      return () => {
        unsubscribe()
        listeners.delete(listener)
      }
    },
    setOption: vi.fn(),
    invokeAction: vi.fn(),
    recordOutgoingCommand: vi.fn(),
    reportSessionOptions: vi.fn(),
    replaceModels: vi.fn()
  } as unknown as NativeChatPtySessionOptionsSurface
  return {
    surface,
    resolveModel: () => {
      snapshot = [RESOLVED_MODEL]
      for (const listener of Array.from(listeners)) {
        listener(snapshot)
      }
    },
    unsubscribe
  }
}

function renderRevision(surface: NativeChatPtySessionOptionsSurface, targetPtyId = 'pty-1') {
  return renderHook(() =>
    useClaudeStartupFrameRevision({
      agent: 'claude',
      terminalTabId: 'tab-1',
      targetPtyId,
      surface
    })
  )
}

describe('useClaudeStartupFrameRevision', () => {
  let emitData: () => void
  let unsubscribeLocal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getSettings.mockReset().mockReturnValue({ activeRuntimeEnvironmentId: 'env-1' })
    mocks.subscribeLocal.mockReset()
    mocks.subscribeRemote.mockReset()
    unsubscribeLocal = vi.fn()
    emitData = () => {}
    mocks.subscribeLocal.mockImplementation((_ptyId: string, watcher: () => void) => {
      emitData = watcher
      return unsubscribeLocal
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bumps after PTY output settles', async () => {
    const { surface } = createSurface()
    const { result } = renderRevision(surface)

    act(() => emitData())
    expect(result.current).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(100))

    expect(result.current).toBe(1)
  })

  it('debounces a burst into one bump', async () => {
    const { surface } = createSurface()
    const { result } = renderRevision(surface)

    act(() => {
      emitData()
      emitData()
      emitData()
    })
    await act(async () => vi.advanceTimersByTimeAsync(100))

    expect(result.current).toBe(1)
  })

  it('keeps retrying after a burst while the model is unresolved', async () => {
    const { surface } = createSurface()
    const { result } = renderRevision(surface)

    act(() => emitData())
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(result.current).toBe(1)

    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(result.current).toBe(2)
  })

  it('stops and unsubscribes once the model resolves', async () => {
    const { surface, resolveModel, unsubscribe } = createSurface()
    const { result } = renderRevision(surface)

    act(resolveModel)
    expect(unsubscribeLocal).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()

    act(() => emitData())
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(result.current).toBe(0)
  })

  it('unsubscribes when the startup window expires', async () => {
    const { surface } = createSurface()
    const { result } = renderRevision(surface)

    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(unsubscribeLocal).toHaveBeenCalledOnce()

    act(() => emitData())
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(result.current).toBe(0)
  })

  it('routes remote PTYs through the runtime stream', async () => {
    const { surface } = createSurface()
    const unsubscribeRemote = vi.fn()
    mocks.subscribeRemote.mockResolvedValue(unsubscribeRemote)

    const hook = renderRevision(surface, 'remote:env-1@@pty-1')
    await act(async () => {
      await mocks.subscribeRemote.mock.results[0]?.value
    })

    expect(mocks.subscribeLocal).not.toHaveBeenCalled()
    expect(mocks.subscribeRemote).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'env-1' },
      'remote:env-1@@pty-1',
      'desktop:native-chat-startup-frame:remote:env-1@@pty-1',
      expect.any(Function)
    )
    hook.unmount()
    expect(unsubscribeRemote).toHaveBeenCalledOnce()
  })

  it('disposes a remote subscription that resolves after unmount', async () => {
    const { surface } = createSurface()
    let resolveSubscription: (dispose: () => void) => void = () => {}
    mocks.subscribeRemote.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveSubscription = resolve
      })
    )
    const unsubscribeRemote = vi.fn()

    const hook = renderRevision(surface, 'remote:env-1@@pty-1')
    hook.unmount()
    await act(async () => resolveSubscription(unsubscribeRemote))

    expect(unsubscribeRemote).toHaveBeenCalledOnce()
  })
})
