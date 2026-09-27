// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { AskPendingCountBadge } from './AskPendingCountBadge'
import type { AskCardModel } from '../../store/slices/fork-ask-question-tool/asks'

function pendingCard(askId: string): AskCardModel {
  return { askId, paneKey: null, status: 'registered', spec: null, partial: {} }
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ pendingAsksByPaneKey: {} })
})

describe('AskPendingCountBadge', () => {
  it('renders nothing when no ask is pending', () => {
    useAppStore.setState({ pendingAsksByPaneKey: {} })
    render(<AskPendingCountBadge />)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('appears immediately for a single pending ask', () => {
    useAppStore.setState({
      pendingAsksByPaneKey: { 'pane-a': [pendingCard('ask-1')] }
    })
    render(<AskPendingCountBadge />)
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('reflects the global count selector across multiple panes', () => {
    useAppStore.setState({
      pendingAsksByPaneKey: {
        'pane-a': [pendingCard('ask-1')],
        'pane-b': [pendingCard('ask-2'), { ...pendingCard('ask-3'), status: 'answered' }]
      }
    })
    render(<AskPendingCountBadge />)
    // ask-3 is terminal (answered) and must not count toward the badge.
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
