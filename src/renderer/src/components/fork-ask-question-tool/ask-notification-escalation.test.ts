// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const mocks = vi.hoisted(() => ({
  storeState: {
    activeWorktreeId: null as string | null,
    activeTabId: null as string | null,
    terminalLayoutsByTabId: {} as Record<string, { activeLeafId: string | null }>,
    worktreesByRepo: {} as Record<string, unknown[]>
  }
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
    { getState: () => mocks.storeState }
  )
  return { useAppStore }
})

import {
  ASK_NOTIFICATION_ESCALATION_DELAY_MS,
  useAskNotificationEscalation
} from './ask-notification-escalation'

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function setPaneFocused(focused: boolean): void {
  mocks.storeState.activeWorktreeId = focused ? WORKTREE_ID : null
  mocks.storeState.activeTabId = focused ? TAB_ID : null
  mocks.storeState.terminalLayoutsByTabId = focused ? { [TAB_ID]: { activeLeafId: LEAF_ID } } : {}
}

function stubNotificationsDispatch(): ReturnType<typeof vi.fn> {
  const dispatch = vi.fn().mockResolvedValue({ delivered: true })
  ;(window as unknown as { api: unknown }).api = { notifications: { dispatch } }
  return dispatch
}

function renderEscalation(initialStatus: 'registered' | 'answered' = 'registered') {
  return renderHook(
    (props: { status: 'registered' | 'answered' }) =>
      useAskNotificationEscalation({
        askId: 'ask-1',
        status: props.status,
        worktreeId: WORKTREE_ID,
        paneKey: PANE_KEY
      }),
    { initialProps: { status: initialStatus } }
  )
}

describe('useAskNotificationEscalation', () => {
  let dispatch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    document.hasFocus = vi.fn(() => true)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    setPaneFocused(false)
    dispatch = stubNotificationsDispatch()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('fires the escalation notification when the pane stays unfocused for the full delay', () => {
    renderEscalation()

    act(() => {
      vi.advanceTimersByTime(ASK_NOTIFICATION_ESCALATION_DELAY_MS)
    })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      source: 'pending-ask',
      worktreeId: WORKTREE_ID,
      paneKey: PANE_KEY
    })
  })

  it('cancels the escalation when the pane is focused before the delay elapses', () => {
    const { rerender } = renderEscalation()

    act(() => {
      vi.advanceTimersByTime(ASK_NOTIFICATION_ESCALATION_DELAY_MS / 2)
    })

    setPaneFocused(true)
    rerender({ status: 'registered' })

    act(() => {
      vi.advanceTimersByTime(ASK_NOTIFICATION_ESCALATION_DELAY_MS)
    })

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not notify when the timer fires after focus returned through a path the hook never re-rendered against', () => {
    renderEscalation()

    // no rerender follows: the reactive cancellation path above never runs, so only the
    // fire-time re-check inside the timer callback can catch that focus came back
    setPaneFocused(true)

    act(() => {
      vi.advanceTimersByTime(ASK_NOTIFICATION_ESCALATION_DELAY_MS)
    })

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('cancels the escalation when the ask resolves before the delay elapses', () => {
    const { rerender } = renderEscalation()

    act(() => {
      vi.advanceTimersByTime(ASK_NOTIFICATION_ESCALATION_DELAY_MS / 2)
    })

    rerender({ status: 'answered' })

    act(() => {
      vi.advanceTimersByTime(ASK_NOTIFICATION_ESCALATION_DELAY_MS)
    })

    expect(dispatch).not.toHaveBeenCalled()
  })
})
