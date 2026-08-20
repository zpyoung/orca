// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentComposerDraftCacheForTests,
  subscribeAgentComposerDraftCache
} from './agent-composer-draft-cache'
import { useAgentComposerDraft } from './use-agent-composer-draft'

afterEach(() => {
  clearAgentComposerDraftCacheForTests()
})

describe('useAgentComposerDraft', () => {
  it('draft survives unmount and remount for the same paneKey', () => {
    const first = renderHook(() => useAgentComposerDraft('pane-1'))
    act(() => {
      first.result.current.setDraft('first draft')
    })
    first.unmount()

    const second = renderHook(() => useAgentComposerDraft('pane-1'))
    expect(second.result.current.draft).toBe('first draft')
  })

  it('does not share drafts between different paneKeys', () => {
    const mountA = renderHook(() => useAgentComposerDraft('pane-a'))
    act(() => {
      mountA.result.current.setDraft('only in A')
    })

    const mountB = renderHook(() => useAgentComposerDraft('pane-b'))
    expect(mountB.result.current.draft).toBe('')
  })

  it('two concurrently-mounted hooks on the same paneKey observe each other’s writes', () => {
    const mountA = renderHook(() => useAgentComposerDraft('pane-shared'))
    const mountB = renderHook(() => useAgentComposerDraft('pane-shared'))

    act(() => {
      mountA.result.current.setDraft('from A')
    })
    expect(mountB.result.current.draft).toBe('from A')

    act(() => {
      mountB.result.current.setDraft('from B')
    })
    expect(mountA.result.current.draft).toBe('from B')
  })

  it('a throwing subscriber does not prevent other mounts from being notified', () => {
    const mountA = renderHook(() => useAgentComposerDraft('pane-throwing'))
    const mountB = renderHook(() => useAgentComposerDraft('pane-throwing'))
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const unsubscribe = subscribeAgentComposerDraftCache('pane-throwing', throwing)

    act(() => {
      mountA.result.current.setDraft('from A')
    })

    expect(mountB.result.current.draft).toBe('from A')
    unsubscribe()
  })

  it('functional updates resolve against the live cache value, not stale mount state', () => {
    const mountA = renderHook(() => useAgentComposerDraft('pane-functional'))
    const mountB = renderHook(() => useAgentComposerDraft('pane-functional'))

    act(() => {
      mountB.result.current.setDraft('from B')
    })

    act(() => {
      mountA.result.current.setDraft((previous) => `${previous} + from A`)
    })

    expect(mountA.result.current.draft).toBe('from B + from A')
    expect(mountB.result.current.draft).toBe('from B + from A')
  })
})
