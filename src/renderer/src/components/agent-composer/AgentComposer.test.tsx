// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
vi.mock('../native-chat/NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))

const mocks = vi.hoisted(() => ({
  sendHandle: { cancel: vi.fn(), settleAfterMs: 0 },
  sendNativeChatMessage: vi.fn()
}))
mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)

vi.mock('../native-chat/native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))

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

    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', 'hello there', undefined)
    expect(textarea.value).toBe('')
  })

  it('never requires anything beyond core props to render the composer field', () => {
    render(
      <AgentComposer terminalTabId="tab-2" paneKey="pane-2" targetPtyId={null} agent="codex" />
    )

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})
