// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pushHistory } from './agent-composer-history'
import {
  clearAgentComposerHistoryCacheForTests,
  subscribeAgentComposerHistoryCache
} from './agent-composer-history-cache'
import { useAgentComposerHistory } from './use-agent-composer-history'

afterEach(() => {
  clearAgentComposerHistoryCacheForTests()
})

describe('useAgentComposerHistory', () => {
  it('recall survives unmount and remount for the same paneKey', () => {
    const first = renderHook(() => useAgentComposerHistory('pane-1'))
    act(() => {
      first.result.current.setHistory((previous) => pushHistory(previous, 'first message'))
    })
    first.unmount()

    const second = renderHook(() => useAgentComposerHistory('pane-1'))
    expect(second.result.current.history.entries).toEqual(['first message'])
  })

  it('does not share history between different paneKeys', () => {
    const mountA = renderHook(() => useAgentComposerHistory('pane-a'))
    act(() => {
      mountA.result.current.setHistory((previous) => pushHistory(previous, 'only in A'))
    })

    const mountB = renderHook(() => useAgentComposerHistory('pane-b'))
    expect(mountB.result.current.history.entries).toEqual([])
  })

  it('two concurrently-mounted hooks on the same paneKey observe each other’s pushes', () => {
    const mountA = renderHook(() => useAgentComposerHistory('pane-shared'))
    const mountB = renderHook(() => useAgentComposerHistory('pane-shared'))

    act(() => {
      mountA.result.current.setHistory((previous) => pushHistory(previous, 'from A'))
    })
    expect(mountB.result.current.history.entries).toEqual(['from A'])

    act(() => {
      mountB.result.current.setHistory((previous) => pushHistory(previous, 'from B'))
    })
    expect(mountA.result.current.history.entries).toEqual(['from A', 'from B'])
  })

  it('interleaved writes from both live mounts lose no entries', () => {
    const mountA = renderHook(() => useAgentComposerHistory('pane-interleaved'))
    const mountB = renderHook(() => useAgentComposerHistory('pane-interleaved'))

    act(() => {
      mountA.result.current.setHistory((previous) => pushHistory(previous, 'from A'))
      mountB.result.current.setHistory((previous) => pushHistory(previous, 'from B'))
    })

    expect(mountA.result.current.history.entries).toEqual(['from A', 'from B'])
    expect(mountB.result.current.history.entries).toEqual(['from A', 'from B'])
  })

  it('a throwing subscriber does not prevent other mounts from being notified', () => {
    const mountA = renderHook(() => useAgentComposerHistory('pane-throwing'))
    const mountB = renderHook(() => useAgentComposerHistory('pane-throwing'))
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const unsubscribe = subscribeAgentComposerHistoryCache('pane-throwing', throwing)

    act(() => {
      mountA.result.current.setHistory((previous) => pushHistory(previous, 'from A'))
    })

    expect(mountB.result.current.history.entries).toEqual(['from A'])
    unsubscribe()
  })
})
