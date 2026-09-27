// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getWorkspaceActivityFilterContext,
  useWorkspaceActivityFilter,
  WORKSPACE_ACTIVITY_CUTOFF_TICK_MS
} from './use-workspace-activity-filter'

const initialState = useAppStore.getInitialState()

describe('getWorkspaceActivityFilterContext', () => {
  it('derives every call from the state it is given', () => {
    const week = { ...initialState, workspaceActivityWindow: 'week' } as AppState
    const month = { ...initialState, workspaceActivityWindow: 'month' } as AppState

    expect(getWorkspaceActivityFilterContext(week).workspaceActivityWindow).toBe('week')
    expect(getWorkspaceActivityFilterContext(month).workspaceActivityWindow).toBe('month')
    expect(getWorkspaceActivityFilterContext(week).workspaceActivityWindow).toBe('week')
  })
})

describe('useWorkspaceActivityFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  it('keeps its identity across unrelated store writes', () => {
    useAppStore.setState({ workspaceActivityWindow: 'week' })
    const { result } = renderHook(() => useWorkspaceActivityFilter())
    const first = result.current

    act(() => useAppStore.setState({ sortBy: 'name' }))
    expect(result.current).toBe(first)

    act(() => useAppStore.setState({ workspaceActivityWindow: 'month' }))
    expect(result.current).not.toBe(first)
    expect(result.current.workspaceActivityWindow).toBe('month')
  })

  it('advances the cutoff clock for a time-based window on a quiet sidebar', () => {
    useAppStore.setState({ workspaceActivityWindow: 'today' })
    const { result } = renderHook(() => useWorkspaceActivityFilter())
    expect(result.current.now).toBe(1_000)

    act(() => vi.advanceTimersByTime(WORKSPACE_ACTIVITY_CUTOFF_TICK_MS))
    expect(result.current.now).toBe(1_000 + WORKSPACE_ACTIVITY_CUTOFF_TICK_MS)
  })

  it('does not tick while the window is not time-based', () => {
    useAppStore.setState({ workspaceActivityWindow: 'all' })
    const { result } = renderHook(() => useWorkspaceActivityFilter())
    const first = result.current

    act(() => vi.advanceTimersByTime(WORKSPACE_ACTIVITY_CUTOFF_TICK_MS * 2))
    expect(result.current).toBe(first)
  })
})
