// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('../NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))

const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputAcceptance = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputAcceptance: (...args: unknown[]) => sendRuntimePtyInputAcceptance(...args),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...args)
}))

import { useAgentComposerCoreState } from './AgentComposer'
import { useAgentComposerSend } from './use-agent-composer-send'
import type { AgentComposerCoreProps } from './agent-composer-types'
import {
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  resetNativeChatPtySendQueuesForTests
} from '../native-chat-runtime-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from '../native-chat-send'

function useHarness(props: AgentComposerCoreProps) {
  const core = useAgentComposerCoreState(props)
  const send = useAgentComposerSend(core, props, undefined, [])
  return { core, send }
}

describe('useAgentComposerSend (tier-independent retention)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputAcceptance.mockResolvedValue(true)
    resetNativeChatPtySendQueuesForTests()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
    vi.clearAllMocks()
  })

  it('still delivers a send with no sendTier prop set', async () => {
    const { result } = renderHook(() =>
      useHarness({
        terminalTabId: 'tab-native-chat',
        paneKey: 'pane-native-chat',
        targetPtyId: 'pty-native-chat',
        agent: 'claude'
      })
    )

    act(() => result.current.core.setDraft('plain send'))
    act(() => result.current.send())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    })

    expect(sendRuntimePtyInputAcceptance).toHaveBeenCalledWith(
      {},
      'pty-native-chat',
      buildNativeChatPasteBytes('plain send'),
      expect.any(Function)
    )
    expect(sendRuntimePtyInputAcceptance).toHaveBeenCalledWith(
      {},
      'pty-native-chat',
      NATIVE_CHAT_SUBMIT
    )
    expect(result.current.core.draft).toBe('')
  })

  it('fires exactly one may-not-have-sent and visibly restores the payload when a tier-less send is cancelled mid-flight', async () => {
    const onSendOutcome = vi.fn()
    const { result } = renderHook(() =>
      useHarness({
        terminalTabId: 'tab-native-chat-cancel',
        paneKey: 'pane-native-chat-cancel',
        targetPtyId: 'pty-native-chat-cancel',
        agent: 'claude',
        onSendOutcome
      })
    )

    act(() => result.current.core.setDraft('hello there'))
    act(() => result.current.send())
    // Let the body write's acceptance promise resolve so the delayed Enter is
    // armed — this is the "mid-flight" window a Stop/interrupt can land in.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.core.draft).toBe('')

    act(() => result.current.core.interrupt())

    expect(onSendOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
    expect(result.current.core.draft).toBe('hello there\n\n')

    // The delayed Enter must never fire after cancellation.
    sendRuntimePtyInputAcceptance.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    })
    expect(sendRuntimePtyInputAcceptance).not.toHaveBeenCalledWith(
      {},
      'pty-native-chat-cancel',
      NATIVE_CHAT_SUBMIT
    )
  })
})
