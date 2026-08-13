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

import {
  AUTO_UNDOCK_HIGH_THRESHOLD_PX,
  AUTO_UNDOCK_LOW_THRESHOLD_PX,
  TerminalDock,
  terminalDockGutterHeightPx
} from './TerminalDock'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const baseProps = {
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  targetPtyId: 'pty-1',
  agent: 'claude' as const,
  paneHeightPx: AUTO_UNDOCK_HIGH_THRESHOLD_PX + 100,
  disabledReason: null
}

describe('TerminalDock', () => {
  it('renders the composer and accepts typing', () => {
    render(<TerminalDock {...baseProps} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea).toBeEnabled()
    fireEvent.change(textarea, { target: { value: 'hello dock' } })
    expect(textarea.value).toBe('hello dock')
  })

  it('marks its interactive dock chrome so pointerdown never yanks terminal focus', () => {
    render(<TerminalDock {...baseProps} />)
    const dock = screen.getByRole('status').closest('[data-terminal-dock]')
    expect(dock).toHaveAttribute('data-pane-prevent-terminal-focus')
  })

  it('shows a specific disabled reason and disables the composer, without changing layout', () => {
    const { container: enabledContainer } = render(<TerminalDock {...baseProps} />)
    const enabledHeight = (enabledContainer.firstChild as HTMLElement).style.height
    cleanup()

    render(<TerminalDock {...baseProps} disabledReason="Reconnecting" />)
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting')
    expect(screen.getByRole('textbox')).toBeDisabled()

    const disabledContainer = screen.getByRole('status').closest('[data-terminal-dock]')
    expect((disabledContainer as HTMLElement).style.height).toBe(enabledHeight)
  })

  it('reserves space for the reason even when there is none, so the reason toggling does not reflow', () => {
    render(<TerminalDock {...baseProps} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('')
    expect(status.firstElementChild).toHaveClass('invisible')
  })

  it('keeps the gutter height fixed regardless of draft length', () => {
    render(<TerminalDock {...baseProps} />)
    const dock = screen.getByRole('status').closest('[data-terminal-dock]') as HTMLElement
    const shortHeight = dock.style.height

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'x'.repeat(4000) } })

    expect(dock.style.height).toBe(shortHeight)
    expect(dock.style.height).toBe(`${terminalDockGutterHeightPx(5)}px`)
  })

  it('unmounts below the low threshold', () => {
    render(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_LOW_THRESHOLD_PX - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('stays mounted between the low and high thresholds once already mounted (no flap on 1px)', () => {
    const { rerender } = render(<TerminalDock {...baseProps} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_HIGH_THRESHOLD_PX - 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_HIGH_THRESHOLD_PX + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('stays unmounted between the low and high thresholds once already unmounted (no flap on 1px)', () => {
    const { rerender } = render(
      <TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_LOW_THRESHOLD_PX - 1} />
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_LOW_THRESHOLD_PX + 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_HIGH_THRESHOLD_PX - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('re-mounts once the height reaches the high threshold', () => {
    const { rerender } = render(
      <TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_LOW_THRESHOLD_PX - 1} />
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_HIGH_THRESHOLD_PX} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('preserves the draft across an auto-undock/re-dock cycle via the paneKey-scoped cache', () => {
    const { rerender } = render(<TerminalDock {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mid sentence' } })

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_LOW_THRESHOLD_PX - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={AUTO_UNDOCK_HIGH_THRESHOLD_PX + 1} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('mid sentence')
  })
})
