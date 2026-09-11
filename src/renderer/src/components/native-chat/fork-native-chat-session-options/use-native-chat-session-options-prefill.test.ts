// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../shared/agent-session-option-catalog'
import type { NativeChatSessionOptionObservation } from '../../../../../shared/native-chat-types'
import { clearNativeChatModelEnrichmentForTests } from '../native-chat-session-option-enrichment'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()
const unsubscribePtyData = vi.fn()
let ptyDataObserver: (data: string) => void = () => {}

vi.mock('../../terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (_ptyId: string, observer: (data: string) => void) => {
    ptyDataObserver = observer
    return unsubscribePtyData
  }
}))

vi.mock('../native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'host', runtime: null }),
  discoverNativeChatCatalogModels: () => discoverModels()
}))

vi.mock('../../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ settings: {}, updateSettings: async () => undefined })
  })
}))

import { useNativeChatSessionOptions } from '../use-native-chat-session-options'

beforeEach(() => {
  unsubscribePtyData.mockReset()
  ptyDataObserver = () => {}
})

// A 1M-context Opus session: the frame names the resolved model while the
// host's discovered catalog names the alias.
const CLAUDE_SCREEN =
  'Claude Code v2.1.220\r\nOpus 5 (1M context) with high effort · API Usage Billing\r\n~/repo'
const CLAUDE_HAIKU_SCREEN = 'Claude Code v2.1.220\r\nHaiku · API Usage Billing\r\n~/repo'

const DISCOVERED: CatalogModel[] = [
  { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
  { id: 'haiku', label: 'Haiku', options: [] }
]

function modelDescriptor(snapshot: { id: string; kind: unknown }[]): {
  currentValue?: string
  choices: { value: string }[]
} {
  const model = snapshot.find((descriptor) => descriptor.id === 'model')
  return model?.kind as { currentValue?: string; choices: { value: string }[] }
}

function effortValue(snapshot: { id: string; kind: unknown }[]): string | undefined {
  const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
  return (effort?.kind as { currentValue?: string } | undefined)?.currentValue
}

describe('useNativeChatSessionOptions mid-session option changes', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    discoverModels.mockReset()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('keeps a dispatched effort when the host re-renders with a fresh screen reader', async () => {
    discoverModels.mockReturnValue(new Promise(() => {}))
    const dispatchCommand = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-dock',
        targetPtyId: 'pty-dock',
        dispatchCommand,
        // The dock host builds this closure inline, so every render passes a new one.
        readTerminalScreen: () => CLAUDE_SCREEN
      })
    )

    await waitFor(() => expect(effortValue(result.current.snapshot)).toBe('high'))

    await act(async () => {
      await result.current.surface?.setOption('effort', 'max')
    })
    expect(dispatchCommand).toHaveBeenCalledWith('/effort max')
    expect(effortValue(result.current.snapshot)).toBe('max')

    rerender()
    expect(effortValue(result.current.snapshot)).toBe('max')
  })
})

describe('useNativeChatSessionOptions session-log pre-fill', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    discoverModels.mockReset()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('pre-fills model and effort from the log with no readable frame', async () => {
    // The case the scrape cannot serve: the startup frame scrolled away turns ago.
    discoverModels.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-log',
        targetPtyId: 'pty-log',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => 'conversation has scrolled past the frame',
        reportedSessionOptions: { model: 'claude-opus-5', effort: 'xhigh', observedAt: 500 }
      })
    )

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
    expect(effortValue(result.current.snapshot)).toBe('xhigh')
  })

  it('re-resolves the logged model against ids discovered after the read', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-refine',
        targetPtyId: 'pty-refine',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => null,
        reportedSessionOptions: { model: 'opus[1m]', effort: 'high', observedAt: 500 }
      })
    )

    // Before the probe only the seed families exist, so the id resolves to `opus`.
    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
    resolveDiscovery(DISCOVERED)
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus[1m]')
    )
  })

  it('does not let the log revert an effort dispatched after that turn ran', async () => {
    discoverModels.mockReturnValue(new Promise(() => {}))
    const dispatchCommand = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ observedAt }: { observedAt: number }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-stale',
          targetPtyId: 'pty-stale',
          dispatchCommand,
          readTerminalScreen: () => null,
          reportedSessionOptions: { model: 'claude-opus-5', effort: 'high', observedAt }
        }),
      { initialProps: { observedAt: 1 } }
    )

    await waitFor(() => expect(effortValue(result.current.snapshot)).toBe('high'))
    await act(async () => {
      await result.current.surface?.setOption('effort', 'max')
    })
    expect(effortValue(result.current.snapshot)).toBe('max')

    // A turn already in flight when /effort max was sent still logs the old level.
    rerender({ observedAt: 2 })
    expect(effortValue(result.current.snapshot)).toBe('max')
  })

  it('falls back to the frame when the host reports no session options', async () => {
    discoverModels.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-fallback',
        targetPtyId: 'pty-fallback',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => CLAUDE_SCREEN
      })
    )

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
    expect(effortValue(result.current.snapshot)).toBe('high')
  })
})

describe('useNativeChatSessionOptions startup-frame repaint', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    discoverModels.mockReset().mockReturnValue(new Promise(() => {}))
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('re-scrapes after PTY output paints the startup frame', async () => {
    let screen = 'shell output before Claude starts'
    const dispatchCommand = vi.fn()
    const readTerminalScreen = (): string => screen
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-startup',
        targetPtyId: 'pty-startup',
        dispatchCommand,
        readTerminalScreen
      })
    )

    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
    screen = CLAUDE_SCREEN
    act(() => ptyDataObserver('startup frame repaint'))

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
    expect(unsubscribePtyData).toHaveBeenCalledOnce()
  })

  it('retries when the renderer applies the frame after the first scrape', async () => {
    vi.useFakeTimers()
    let unmount = () => {}
    try {
      let screen = 'shell output before Claude starts'
      const dispatchCommand = vi.fn()
      const readTerminalScreen = (): string => screen
      const hook = renderHook(() =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-delayed-frame',
          targetPtyId: 'pty-delayed-frame',
          dispatchCommand,
          readTerminalScreen
        })
      )
      unmount = hook.unmount

      act(() => ptyDataObserver('startup frame repaint'))
      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(modelDescriptor(hook.result.current.snapshot).currentValue).toBeUndefined()

      screen = CLAUDE_SCREEN
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(modelDescriptor(hook.result.current.snapshot).currentValue).toBe('opus')
      expect(unsubscribePtyData).toHaveBeenCalledOnce()
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('ignores later PTY data after resolving instead of reverting a dispatched pick', async () => {
    let screen = 'shell output before Claude starts'
    const readTerminalScreen = vi.fn(() => screen)
    const dispatchCommand = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-stable',
        targetPtyId: 'pty-stable',
        dispatchCommand,
        readTerminalScreen
      })
    )

    screen = CLAUDE_SCREEN
    act(() => ptyDataObserver('startup frame repaint'))
    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))

    await act(async () => {
      await result.current.surface?.setOption('effort', 'max')
    })
    expect(effortValue(result.current.snapshot)).toBe('max')
    const readsAfterResolution = readTerminalScreen.mock.calls.length

    act(() => ptyDataObserver('later conversation output'))
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150))
    })

    expect(readTerminalScreen).toHaveBeenCalledTimes(readsAfterResolution)
    expect(effortValue(result.current.snapshot)).toBe('max')
  })

  it('does not let a late snapshot overwrite a dispatched model', async () => {
    let resolveSnapshot: (value: { data: string; alternateScreen: false }) => void = () => {}
    const snapshot = new Promise<{ data: string; alternateScreen: false }>((resolve) => {
      resolveSnapshot = resolve
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { getMainBufferSnapshot: vi.fn().mockReturnValue(snapshot) } }
    })
    const dispatchCommand = vi.fn().mockResolvedValue(undefined)
    const readTerminalScreen = (): null => null
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-dispatch-race',
        targetPtyId: 'pty-dispatch-race',
        dispatchCommand,
        readTerminalScreen
      })
    )

    await act(async () => {
      await result.current.surface?.setOption('model', 'haiku')
    })
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('haiku')

    await act(async () => {
      resolveSnapshot({ data: CLAUDE_SCREEN, alternateScreen: false })
      await snapshot
    })
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('haiku')
  })

  it('does not let a late snapshot overwrite an authoritative log report', async () => {
    let resolveSnapshot: (value: { data: string; alternateScreen: false }) => void = () => {}
    const snapshot = new Promise<{ data: string; alternateScreen: false }>((resolve) => {
      resolveSnapshot = resolve
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { getMainBufferSnapshot: vi.fn().mockReturnValue(snapshot) } }
    })
    const dispatchCommand = vi.fn()
    const readTerminalScreen = (): null => null
    const hook = renderHook(
      ({
        reportedSessionOptions
      }: {
        reportedSessionOptions: NativeChatSessionOptionObservation | null
      }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-log-race',
          targetPtyId: 'pty-log-race',
          dispatchCommand,
          readTerminalScreen,
          reportedSessionOptions
        }),
      {
        initialProps: {
          reportedSessionOptions: null as NativeChatSessionOptionObservation | null
        }
      }
    )

    hook.rerender({
      reportedSessionOptions: { model: 'claude-opus-5', effort: 'max', observedAt: 500 }
    })
    await waitFor(() =>
      expect(modelDescriptor(hook.result.current.snapshot).currentValue).toBe('opus')
    )

    await act(async () => {
      resolveSnapshot({ data: CLAUDE_HAIKU_SCREEN, alternateScreen: false })
      await snapshot
    })
    expect(modelDescriptor(hook.result.current.snapshot).currentValue).toBe('opus')
    expect(effortValue(hook.result.current.snapshot)).toBe('max')
  })
})
