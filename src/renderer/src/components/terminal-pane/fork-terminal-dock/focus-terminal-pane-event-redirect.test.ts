import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../../shared/stable-pane-id'
import { handleFocusTerminalPaneDetail } from '../focus-terminal-pane-event'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId

function createManager(hasComposer: boolean) {
  const composer = { focus: vi.fn() }
  const terminal = { focus: vi.fn() }
  const container = {
    querySelector: vi.fn(() => (hasComposer ? composer : null))
  } as unknown as HTMLElement
  return {
    composer,
    terminal,
    manager: {
      getNumericIdForLeaf: vi.fn(() => 7),
      getPanes: vi.fn(() => [{ id: 7, leafId: LEAF_ID, container, terminal }]),
      setActivePane: vi.fn()
    }
  }
}

function focusPane(manager: ReturnType<typeof createManager>['manager']): void {
  handleFocusTerminalPaneDetail(
    { tabId: 'tab-1', leafId: LEAF_ID },
    {
      tabId: 'tab-1',
      manager,
      acknowledgeAgents: vi.fn(),
      surfaceStaleAgentRow: vi.fn()
    }
  )
}

describe('handleFocusTerminalPaneDetail dock redirect', () => {
  it('focuses the enabled dock composer after activating its pane', () => {
    const { composer, manager, terminal } = createManager(true)

    focusPane(manager)

    expect(manager.setActivePane).toHaveBeenCalledWith(7, { focus: false })
    expect(composer.focus).toHaveBeenCalledOnce()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('falls back to the terminal when the pane has no enabled composer', () => {
    const { composer, manager, terminal } = createManager(false)

    focusPane(manager)

    expect(manager.setActivePane).toHaveBeenCalledWith(7, { focus: false })
    expect(terminal.focus).toHaveBeenCalledOnce()
    expect(composer.focus).not.toHaveBeenCalled()
  })
})
