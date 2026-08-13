// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { pushHistory } from './agent-composer-history'
import { clearAgentComposerHistoryCacheForTests } from './agent-composer-history-cache'
import { useAgentComposerHistory } from './use-agent-composer-history'

afterEach(() => {
  clearAgentComposerHistoryCacheForTests()
})

describe('useAgentComposerHistory', () => {
  it('recall survives unmount and remount for the same paneKey', () => {
    const first = renderHook(() => useAgentComposerHistory('pane-1'))
    first.result.current.setHistory((previous) => pushHistory(previous, 'first message'))
    first.unmount()

    const second = renderHook(() => useAgentComposerHistory('pane-1'))
    expect(second.result.current.history.entries).toEqual(['first message'])
  })

  it('shares history between two mounts on the same paneKey', () => {
    const mountA = renderHook(() => useAgentComposerHistory('pane-shared'))
    mountA.result.current.setHistory((previous) => pushHistory(previous, 'from A'))

    const mountB = renderHook(() => useAgentComposerHistory('pane-shared'))
    expect(mountB.result.current.history.entries).toEqual(['from A'])
  })

  it('does not share history between different paneKeys', () => {
    const mountA = renderHook(() => useAgentComposerHistory('pane-a'))
    mountA.result.current.setHistory((previous) => pushHistory(previous, 'only in A'))

    const mountB = renderHook(() => useAgentComposerHistory('pane-b'))
    expect(mountB.result.current.history.entries).toEqual([])
  })
})
