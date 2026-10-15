// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { registerTerminalPanePasteListeners } from '../terminal-pane-paste-listeners'
import type { TerminalPaneCloseController } from '../use-terminal-pane-close-actions'
import type { TerminalPanePasteExecution } from '../terminal-pane-paste-execution'

const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.innerHTML = ''
})

// Builds a pane container shaped like a docked pane: the xterm's input and the dock's
// chat root are siblings, with no chat cover over either.
function mountDockedPane() {
  const container = document.createElement('div')
  const xtermInput = document.createElement('textarea')
  const dockRoot = document.createElement('div')
  dockRoot.setAttribute('data-native-chat-root', 'true')
  dockRoot.setAttribute('data-terminal-dock', '')
  const composerInput = document.createElement('textarea')
  dockRoot.append(composerInput)
  container.append(xtermInput, dockRoot)
  document.body.append(container)

  const pane = { id: 1 }
  const pasteFromClipboard = vi.fn()
  const controller = {
    forceBracketedMultilineTextPaste: false,
    keybindings: {},
    managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane] } },
    setTerminalError: vi.fn(),
    worktreeId: 'wt-1'
  }
  const execution = { executePanePasteText: vi.fn(), pasteFromClipboard }
  cleanups.push(
    registerTerminalPanePasteListeners({
      container,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listeners read only the five controller fields this fixture supplies.
      controller: controller as unknown as TerminalPaneCloseController,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listeners call only executePanePasteText and pasteFromClipboard.
      execution: execution as unknown as TerminalPanePasteExecution,
      isMac: true,
      shortcutPlatform: 'darwin'
    })
  )
  return { xtermInput, composerInput, pasteFromClipboard }
}

function pressCmdV(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'v',
    code: 'KeyV',
    metaKey: true,
    bubbles: true,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event
}

function firePaste(target: HTMLElement): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('terminal pane paste listeners beside a terminal dock', () => {
  it('leave Cmd+V in the dock composer to the dock', () => {
    const { composerInput, pasteFromClipboard } = mountDockedPane()

    const event = pressCmdV(composerInput)

    expect(event.defaultPrevented).toBe(false)
    expect(pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('leave a paste event in the dock composer to the dock', () => {
    const { composerInput, pasteFromClipboard } = mountDockedPane()

    const event = firePaste(composerInput)

    expect(event.defaultPrevented).toBe(false)
    expect(pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('leave an app-menu paste with focus in the dock composer to the dock', () => {
    const { composerInput, pasteFromClipboard } = mountDockedPane()
    composerInput.focus()

    const event = new Event(APP_MENU_PASTE_EVENT, { cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('still paste Cmd+V on the xterm into the terminal', () => {
    const { xtermInput, pasteFromClipboard } = mountDockedPane()

    const event = pressCmdV(xtermInput)

    expect(event.defaultPrevented).toBe(true)
    expect(pasteFromClipboard).toHaveBeenCalledWith({ id: 1 }, 'keyboard')
  })
})
