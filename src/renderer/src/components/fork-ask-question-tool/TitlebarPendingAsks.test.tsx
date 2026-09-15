// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TitlebarLeftControls } from '../../app-shell/TitlebarLeftControls'
import { useAppChromeLayout } from '../../app-shell/use-app-chrome-layout'
import { useAppStore } from '../../store'
import type { AskCardModel } from '../../store/slices/fork-ask-question-tool/asks'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/titlebar-worktree-history-controls', () => ({
  shouldShowWorktreeHistoryControls: () => false
}))

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function ask(askId: string, paneKey: string, status: AskCardModel['status']): AskCardModel {
  return { askId, paneKey, status, spec: null, partial: {} }
}

function TitlebarSubject(): React.JSX.Element {
  return <TitlebarLeftControls layout={useAppChromeLayout()} />
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  useAppStore.setState({
    activeView: 'terminal',
    sidebarOpen: false,
    rightSidebarOpen: false,
    pendingAsksByPaneKey: {
      'pane-a': [ask('ask-1', 'pane-a', 'registered')]
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState({
    activeView: useAppStore.getInitialState().activeView,
    sidebarOpen: useAppStore.getInitialState().sidebarOpen,
    rightSidebarOpen: useAppStore.getInitialState().rightSidebarOpen,
    pendingAsksByPaneKey: {}
  })
})

describe('titlebar pending asks', () => {
  it('keeps the global pending count visible without an open Questions panel', () => {
    render(<TitlebarSubject />)
    expect(screen.getByLabelText('1 pending question')).toHaveTextContent('1')

    act(() => {
      useAppStore.setState({
        pendingAsksByPaneKey: {
          'pane-a': [ask('ask-1', 'pane-a', 'registered')],
          'pane-b': [ask('ask-2', 'pane-b', 'pending'), ask('ask-3', 'pane-b', 'registered')]
        }
      })
    })
    expect(screen.getByLabelText('3 pending questions')).toHaveTextContent('3')

    act(() => {
      useAppStore.setState({
        pendingAsksByPaneKey: {
          'pane-a': [ask('ask-1', 'pane-a', 'answered')],
          'pane-b': [ask('ask-2', 'pane-b', 'declined'), ask('ask-3', 'pane-b', 'timed_out')]
        }
      })
    })
    expect(screen.queryByLabelText(/pending questions?/)).not.toBeInTheDocument()
  })
})
