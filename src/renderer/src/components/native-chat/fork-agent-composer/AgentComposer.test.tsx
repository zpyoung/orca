// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('../NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))

const mocks = vi.hoisted(() => ({
  sendHandle: { cancel: vi.fn(), settleAfterMs: 0 },
  sendNativeChatMessage: vi.fn()
}))
mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)

vi.mock('../native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))

import { buildAgentTuiClearInputForText } from '../../../../../shared/agent-tui-input-clear'
import { AgentComposer } from './AgentComposer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentComposer bare mount', () => {
  it('types and sends with only core props', () => {
    render(
      <AgentComposer terminalTabId="tab-1" paneKey="pane-1" targetPtyId="pty-1" agent="claude" />
    )

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello there' } })
    expect(textarea.value).toBe('hello there')

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Retention/outcome wiring applies even with no sendTier (r4-4): a bare
    // mount still gets clearInput + an onOutcome, just no verified confirm.
    const options = mocks.sendNativeChatMessage.mock.calls[0]?.[3]
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
      {},
      'pty-1',
      'hello there',
      expect.objectContaining({ onOutcome: expect.any(Function) })
    )
    expect(options.confirmCleared).toBeUndefined()
    expect(options.confirmSubmitted).toBeUndefined()
    expect(textarea.value).toBe('')
  })

  it('sends the raw Markdown draft without normalizing it', () => {
    const draft = 'Fix **auth** in `login.ts`  \n@src/main.ts'
    render(
      <AgentComposer
        terminalTabId="tab-markdown"
        paneKey="pane-markdown"
        targetPtyId="pty-1"
        agent="claude"
      />
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(mocks.sendNativeChatMessage.mock.calls[0]?.[2]).toBe(draft)
  })

  it('never requires anything beyond core props to render the composer field', () => {
    render(
      <AgentComposer terminalTabId="tab-2" paneKey="pane-2" targetPtyId={null} agent="codex" />
    )

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('uses verified clear and post-submit screen observation for a verified dock send', () => {
    const readTerminalScreen = vi.fn(() => '❯ ')
    render(
      <AgentComposer
        terminalTabId="tab-verified"
        paneKey="pane-verified"
        targetPtyId="pty-verified"
        agent="claude"
        sendTier="verified"
        readTerminalScreen={readTerminalScreen}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first\nsecond' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const options = mocks.sendNativeChatMessage.mock.calls[0]?.[3]
    expect(options.clearInput).toBe(buildAgentTuiClearInputForText('first\nsecond'))
    expect(options.confirmCleared()).toBe(true)
    expect(options.confirmSubmitted()).toBe(true)
    expect(readTerminalScreen).toHaveBeenCalledTimes(2)
  })

  it('uses input-tier slack clear without observation', () => {
    render(
      <AgentComposer
        terminalTabId="tab-input"
        paneKey="pane-input"
        targetPtyId="pty-input"
        agent="grok"
        sendTier="input"
        readTerminalScreen={vi.fn(() => '› ')}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const options = mocks.sendNativeChatMessage.mock.calls[0]?.[3]
    expect(options.clearInput).toBe(buildAgentTuiClearInputForText('hello'))
    expect(options.confirmCleared).toBeUndefined()
    expect(options.confirmSubmitted).toBeUndefined()
  })

  it('prepends a retained payload without overwriting text typed while the send settles', () => {
    render(
      <AgentComposer
        terminalTabId="tab-restore"
        paneKey="pane-restore"
        targetPtyId="pty-restore"
        agent="claude"
        sendTier="verified"
      />
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'possibly lost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.change(textarea, { target: { value: 'typed after send' } })

    const options = mocks.sendNativeChatMessage.mock.calls[0]?.[3]
    act(() => options.onOutcome('may-not-have-sent'))

    expect(textarea.value).toBe('possibly lost\n\ntyped after send')
    expect(screen.getByText(/Check the terminal before retrying/)).toBeInTheDocument()
  })

  it('can disable Send without disabling draft editing', () => {
    render(
      <AgentComposer
        terminalTabId="tab-card"
        paneKey="pane-card"
        targetPtyId="pty-card"
        agent="claude"
        sendDisabled
      />
    )

    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeEnabled()
    fireEvent.change(textarea, { target: { value: 'draft while card is open' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('cancels a pending send when the transport turns unsafe mid-delay', () => {
    const onOptimisticSendCanceled = vi.fn()
    const { rerender } = render(
      <AgentComposer
        terminalTabId="tab-unsafe"
        paneKey="pane-unsafe"
        targetPtyId="pty-unsafe"
        agent="claude"
        canSend
        onOptimisticSendCanceled={onOptimisticSendCanceled}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(mocks.sendHandle.cancel).not.toHaveBeenCalled()

    rerender(
      <AgentComposer
        terminalTabId="tab-unsafe"
        paneKey="pane-unsafe"
        targetPtyId="pty-unsafe"
        agent="claude"
        canSend={false}
        onOptimisticSendCanceled={onOptimisticSendCanceled}
      />
    )

    expect(mocks.sendHandle.cancel).toHaveBeenCalledTimes(1)
  })

  it('does not cancel a pending send from an agent-status flap alone', () => {
    const { rerender } = render(
      <AgentComposer
        terminalTabId="tab-flap"
        paneKey="pane-flap"
        targetPtyId="pty-flap"
        agent="claude"
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    rerender(
      <AgentComposer
        terminalTabId="tab-flap"
        paneKey="pane-flap"
        targetPtyId="pty-flap"
        agent="claude"
        isWorking
      />
    )

    expect(mocks.sendHandle.cancel).not.toHaveBeenCalled()
  })

  it('keeps Send independent from the working-only Stop action', () => {
    render(
      <AgentComposer
        terminalTabId="tab-busy"
        paneKey="pane-busy"
        targetPtyId="pty-busy"
        agent="claude"
        isWorking
        onStop={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'follow up' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })
})
