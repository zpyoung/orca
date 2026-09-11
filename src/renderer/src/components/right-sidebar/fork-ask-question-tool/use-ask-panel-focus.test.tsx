// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AskCardModel } from '@/store/slices/fork-ask-question-tool/asks'
import type { AskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { useAskPanelFocus } from './use-ask-panel-focus'

// The real hook reads five slices of tab/layout state; the focus machine only cares which pane
// came back, so the resolution itself is stubbed.
let focusedPaneKey: string | null = 'pane-a'
vi.mock('../fork-session-info/focused-session-info', () => ({
  useFocusedPaneKey: () => focusedPaneKey
}))

const ASK_ITEM = [{ id: 'ask' as const }]
const NO_ASK_ITEM = [{ id: 'explorer' as const }]

function card(askId: string, status: AskStatus = 'pending'): AskCardModel {
  return { askId, paneKey: 'pane-a', status, spec: null, partial: {} }
}

function seed(byPane: Record<string, AskCardModel[]>): void {
  act(() => {
    useAppStore.setState({ pendingAsksByPaneKey: byPane })
  })
}

/** Mirrors what the activity bar does: the item exists exactly while the pane has any ask. */
function itemsFor(paneKey: string | null): typeof ASK_ITEM | typeof NO_ASK_ITEM {
  const bucket = paneKey ? useAppStore.getState().pendingAsksByPaneKey[paneKey] : undefined
  return bucket && bucket.length > 0 ? ASK_ITEM : NO_ASK_ITEM
}

function renderFocus() {
  return renderHook(() => useAskPanelFocus('explorer', itemsFor(focusedPaneKey)))
}

beforeEach(() => {
  focusedPaneKey = 'pane-a'
  useAppStore.setState({
    pendingAsksByPaneKey: {},
    askFocusRestoreOpen: null,
    rightSidebarOpen: true,
    rightSidebarRouteRequestId: 0
  })
})

afterEach(cleanup)

describe('useAskPanelFocus', () => {
  it('leaves the routed tab alone when the focused pane has no ask', () => {
    const { result } = renderFocus()
    expect(result.current).toBe('explorer')
  })

  it('takes the sidebar for an unanswered ask on the focused pane', () => {
    const { result, rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    expect(result.current).toBe('ask')
  })

  it('holds through the result flash, then hands the tab back when the ask clears', () => {
    const { result, rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    expect(result.current).toBe('ask')

    // terminal but still queued — the summary is on screen for ASK_DISMISS_DELAY_MS
    seed({ 'pane-a': [card('ask-1', 'answered')] })
    rerender()
    expect(result.current).toBe('ask')

    seed({})
    rerender()
    expect(result.current).toBe('explorer')
  })

  it('never steals focus for an ask that arrived already resolved', () => {
    const { result, rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-1', 'declined')] })
    rerender()
    expect(result.current).toBe('explorer')
  })

  it('releases on an explicit tab choice and does not re-take that same ask', () => {
    const { result, rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    expect(result.current).toBe('ask')

    // Why a bare nonce bump: re-selecting the tab the user is already on writes no new tab
    // value, so the counter is the only thing that moves.
    act(() => {
      useAppStore.setState((s) => ({
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1
      }))
    })
    rerender()
    expect(result.current).toBe('explorer')

    rerender()
    expect(result.current).toBe('explorer')
  })

  it('takes focus again for the next question after one was dismissed', () => {
    const { result, rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    act(() => {
      useAppStore.setState((s) => ({
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1
      }))
    })
    rerender()
    expect(result.current).toBe('explorer')

    seed({ 'pane-a': [card('ask-2')] })
    rerender()
    expect(result.current).toBe('ask')
  })

  it('keeps a dismissal per ask, so dismissing one pane does not revive another', () => {
    const { result, rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-a')], 'pane-b': [{ ...card('ask-b'), paneKey: 'pane-b' }] })
    rerender()
    expect(result.current).toBe('ask')

    act(() => {
      useAppStore.setState((s) => ({
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1
      }))
    })
    rerender()
    expect(result.current).toBe('explorer')

    focusedPaneKey = 'pane-b'
    rerender()
    expect(result.current).toBe('ask')

    act(() => {
      useAppStore.setState((s) => ({
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1
      }))
    })
    rerender()
    expect(result.current).toBe('explorer')

    // back to pane A: its own dismissal must still stand
    focusedPaneKey = 'pane-a'
    rerender()
    expect(result.current).toBe('explorer')
  })

  it('keeps the sidebar open when the user navigates away from a forced-open panel', () => {
    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    const { result, rerender } = renderFocus()

    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
    expect(useAppStore.getState().askFocusRestoreOpen).toBe(false)

    act(() => {
      useAppStore.setState((s) => ({
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1
      }))
    })
    rerender()
    expect(result.current).toBe('explorer')
    // The click chose a tab, not a collapse.
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
    expect(useAppStore.getState().askFocusRestoreOpen).toBeNull()
  })

  it('opens a collapsed sidebar and re-collapses it once the ask clears', () => {
    act(() => {
      useAppStore.setState({ rightSidebarOpen: false })
    })
    const { rerender } = renderFocus()

    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
    expect(useAppStore.getState().askFocusRestoreOpen).toBe(false)

    seed({})
    rerender()
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
    expect(useAppStore.getState().askFocusRestoreOpen).toBeNull()
  })

  it('leaves an already-open sidebar open after the ask clears', () => {
    const { rerender } = renderFocus()
    seed({ 'pane-a': [card('ask-1')] })
    rerender()
    expect(useAppStore.getState().askFocusRestoreOpen).toBeNull()

    seed({})
    rerender()
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
  })
})
