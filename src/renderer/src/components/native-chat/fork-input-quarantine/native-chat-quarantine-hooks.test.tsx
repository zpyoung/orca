// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  invalidateNativeChatPtySends: vi.fn(),
  sendRuntimePtyInput: vi.fn(),
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn(),
  storeState: { agentStatusByPaneKey: {} }
}))

vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  getDriverForPty: () => ({ kind: 'desktop' }),
  onDriverChange: () => () => {}
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => mocks.sendRuntimePtyInput(...args)
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))

vi.mock('../native-chat-runtime-send', () => ({
  invalidateNativeChatPtySends: (...args: unknown[]) => mocks.invalidateNativeChatPtySends(...args),
  sendNativeChatAskAnswer: (...args: unknown[]) => mocks.sendNativeChatAskAnswer(...args),
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args)
}))

import { useNativeChatCanSend } from '../use-native-chat-can-send'
import { useNativeChatInteractiveSend } from '../use-native-chat-interactive-send'
import { useNativeChatSendLifecycle } from '../use-native-chat-send-lifecycle'
import type { AskPrompt } from '../native-chat-interactive-prompt'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine,
  shouldDropQuarantinedTerminalInput
} from '../../terminal-pane/terminal-input-quarantine'

const TAB = 'tab-quarantine'
const PTY = 'pty-quarantine'
const PANE_KEY = `${TAB}:11111111-1111-4111-8111-111111111111`
const PROMPT: AskPrompt = {
  questions: [{ question: 'q', multiSelect: false, options: [{ label: 'A' }] }]
}

describe('native-chat live quarantine hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetTerminalInputQuarantineForTests()
    const handle = { cancel: mocks.cancel, settleAfterMs: 500 }
    mocks.sendNativeChatAskAnswer.mockReturnValue(handle)
    mocks.sendNativeChatMessage.mockReturnValue(handle)
  })

  afterEach(() => {
    cleanup()
    _resetTerminalInputQuarantineForTests()
  })

  it('updates canSend on arm and release while the PTY identity stays unchanged', () => {
    const { result } = renderHook(() => useNativeChatCanSend(TAB, PTY))
    expect(result.current).toBe(true)

    act(() => armTerminalInputQuarantine(TAB))
    expect(result.current).toBe(false)

    act(() => shouldDropQuarantinedTerminalInput(TAB, '\r'))
    expect(result.current).toBe(true)
  })

  it('blocks raw control bytes while quarantine is armed', () => {
    armTerminalInputQuarantine(TAB)
    const { result } = renderHook(() => useNativeChatInteractiveSend(TAB, PANE_KEY, PTY, 'claude'))

    act(() => result.current.sendRaw('\x1b'))

    expect(mocks.sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('rejects an interactive answer while quarantine is armed', () => {
    armTerminalInputQuarantine(TAB)
    const onDeliverySettled = vi.fn()
    const { result } = renderHook(() => useNativeChatInteractiveSend(TAB, PANE_KEY, PTY, 'codex'))

    let sendResult: { settleAfterMs: number; waitsForVerifiedDelivery: boolean } | undefined
    act(() => {
      sendResult = result.current.sendAnswer(PROMPT, [{ indices: [0] }], onDeliverySettled)
    })

    expect(sendResult).toEqual({ settleAfterMs: 0, waitsForVerifiedDelivery: false })
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('invalidates paced answer writes when reattachment arms quarantine', () => {
    const { result } = renderHook(() => useNativeChatInteractiveSend(TAB, PANE_KEY, PTY, 'codex'))
    act(() => result.current.sendAnswer(PROMPT, [{ indices: [0] }]))

    act(() => armTerminalInputQuarantine(TAB))

    expect(mocks.invalidateNativeChatPtySends).toHaveBeenCalledExactlyOnceWith(PTY)
  })

  it('cancels the optimistic pending entry synchronously after no-write invalidation', () => {
    const onPendingSendCanceled = vi.fn()
    const { result } = renderHook(() => useNativeChatSendLifecycle(TAB, PTY, onPendingSendCanceled))
    act(() => {
      result.current.trackPendingSend({ cancel: mocks.cancel, settleAfterMs: 500 }, 'pending-1')
    })

    act(() => armTerminalInputQuarantine(TAB))

    expect(mocks.invalidateNativeChatPtySends).toHaveBeenCalledExactlyOnceWith(PTY)
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledExactlyOnceWith('pending-1')
  })
})
