// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentComposerHandle } from '../agent-composer/agent-composer-types'

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
  TerminalDock,
  terminalDockAutoUndockHighThresholdPx,
  terminalDockAutoUndockLowThresholdPx,
  terminalDockGutterHeightPx
} from './TerminalDock'
import { DEFAULT_GUTTER_ROWS, MAX_GUTTER_ROWS, MIN_GUTTER_ROWS } from './terminal-dock-pane-state'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const baseProps = {
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  targetPtyId: 'pty-1',
  agent: 'claude' as const,
  paneHeightPx: terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS) + 100,
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

  it('exposes the composer imperative handle through its own forwarded ref', () => {
    const ref = createRef<AgentComposerHandle>()
    render(<TerminalDock {...baseProps} ref={ref} />)

    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
    ref.current?.focus()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
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
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('stays mounted between the low and high thresholds once already mounted (no flap on 1px)', () => {
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high - 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('stays unmounted between the low and high thresholds once already unmounted (no flap on 1px)', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={low + 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('re-mounts once the height reaches the high threshold', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('preserves the draft across an auto-undock/re-dock cycle via the paneKey-scoped cache', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mid sentence' } })

    rerender(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high + 1} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('mid sentence')
  })

  it('does not mount a 15-row gutter in a pane too short to fit it', () => {
    const gutterRows = MAX_GUTTER_ROWS
    const tooShort = terminalDockGutterHeightPx(gutterRows)
    render(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={tooShort} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('does not mount the default gutter in a pane too short to fit it', () => {
    render(<TerminalDock {...baseProps} gutterRows={DEFAULT_GUTTER_ROWS} paneHeightPx={180} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('scales thresholds with gutterRows: a height that mounts a 3-row gutter rejects a 15-row one', () => {
    const paneHeightPx = terminalDockAutoUndockHighThresholdPx(MIN_GUTTER_ROWS)

    render(<TerminalDock {...baseProps} gutterRows={MIN_GUTTER_ROWS} paneHeightPx={paneHeightPx} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    cleanup()

    render(<TerminalDock {...baseProps} gutterRows={MAX_GUTTER_ROWS} paneHeightPx={paneHeightPx} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('reports mount and unmount edges exactly once each, not on every render', () => {
    const onMountedChange = vi.fn()
    const { rerender } = render(<TerminalDock {...baseProps} onMountedChange={onMountedChange} />)
    expect(onMountedChange).toHaveBeenCalledTimes(1)
    expect(onMountedChange).toHaveBeenLastCalledWith(true)

    rerender(<TerminalDock {...baseProps} onMountedChange={onMountedChange} gutterRows={6} />)
    expect(onMountedChange).toHaveBeenCalledTimes(1)

    const low = terminalDockAutoUndockLowThresholdPx(6)
    rerender(
      <TerminalDock
        {...baseProps}
        onMountedChange={onMountedChange}
        gutterRows={6}
        paneHeightPx={low - 1}
      />
    )
    expect(onMountedChange).toHaveBeenCalledTimes(2)
    expect(onMountedChange).toHaveBeenLastCalledWith(false)
  })

  it('reports an unmount edge when the host removes the component outright', () => {
    const onMountedChange = vi.fn()
    const { unmount } = render(<TerminalDock {...baseProps} onMountedChange={onMountedChange} />)
    onMountedChange.mockClear()

    unmount()

    expect(onMountedChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('renders a gutter drag handle only when a pointerdown handler is supplied', () => {
    const { rerender } = render(<TerminalDock {...baseProps} />)
    expect(document.querySelector('[data-terminal-dock-gutter-handle]')).not.toBeInTheDocument()

    const onGutterPointerDown = vi.fn()
    rerender(<TerminalDock {...baseProps} onGutterPointerDown={onGutterPointerDown} />)
    const handle = document.querySelector('[data-terminal-dock-gutter-handle]')
    expect(handle).toBeInTheDocument()
    fireEvent.pointerDown(handle as Element)
    expect(onGutterPointerDown).toHaveBeenCalledTimes(1)
  })

  it('shows a passthrough overlay and hides it once passthrough exits', () => {
    const { rerender } = render(<TerminalDock {...baseProps} passthroughActive={true} />)
    expect(screen.getByText(/passthrough active/i)).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} passthroughActive={false} />)
    expect(screen.queryByText(/passthrough active/i)).not.toBeInTheDocument()
  })

  it('does not flap at +/-1px around the derived thresholds for a non-default gutterRows', () => {
    const gutterRows = MAX_GUTTER_ROWS
    const low = terminalDockAutoUndockLowThresholdPx(gutterRows)
    const high = terminalDockAutoUndockHighThresholdPx(gutterRows)

    const { rerender } = render(
      <TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={high + 100} />
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={low + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={high - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={high + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
