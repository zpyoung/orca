// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { queuePanePtyResizeIfHeld } from '@/lib/pane-manager/pane-pty-resize-hold'
import { terminalDockAutoUndockHighThresholdPx } from '../terminal-dock/TerminalDock'
import { DEFAULT_GUTTER_ROWS } from '../terminal-dock/terminal-dock-pane-state'

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
vi.mock('../native-chat/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => ({ cancel: vi.fn(), settleAfterMs: 0 })),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))

import { TerminalPaneDockMount } from './TerminalPaneDockMount'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeFakePane(): ManagedPane {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = '1'
  const dockSlot = document.createElement('div')
  dockSlot.className = 'pane-dock-slot'
  container.appendChild(dockSlot)
  document.body.appendChild(container)
  // Why: happy-dom's getBoundingClientRect is a 0-box by default, which would put every
  // pane below the auto-undock threshold before TerminalDock ever gets a chance to mount.
  container.getBoundingClientRect = () =>
    ({ height: terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS) + 100 }) as DOMRect
  return {
    container,
    // Why: unmeasurable in jsdom (proposeDimensions null) so safeFit's pre-fit
    // measurability gate returns cleanly instead of throwing on a pane with no real xterm.
    fitAddon: { proposeDimensions: () => null, fit: () => {} },
    terminal: { cols: 0, rows: 0, resize: () => {} }
  } as unknown as ManagedPane
}

const baseProps = {
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  agent: 'claude' as const,
  gutterRows: DEFAULT_GUTTER_ROWS,
  targetPtyId: 'pty-1',
  disabledReason: null,
  readTerminalScreen: () => null,
  onCommitGutterRows: vi.fn(),
  passthroughActive: false
}

describe('TerminalPaneDockMount', () => {
  it('renders nothing when not docked', () => {
    const pane = makeFakePane()
    render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('portals the dock into the pane dock slot when docked', () => {
    const pane = makeFakePane()
    render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    const dockSlot = pane.container.querySelector('.pane-dock-slot') as HTMLElement
    expect(dockSlot.querySelector('[data-terminal-dock]')).not.toBeNull()
  })

  it('holds and releases the PTY resize around a dock/undock edge without throwing', () => {
    const pane = makeFakePane()
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)

    const { rerender, unmount } = render(
      <TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />
    )
    // The hold must have been released by the time the mount effect settles, so an
    // unrelated resize attempt right after sends immediately instead of queuing forever.
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)

    rerender(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)
    unmount()
  })
})
