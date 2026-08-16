import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY, pushHistory } from './agent-composer-history'
import {
  clearAgentComposerHistoryCacheForTests,
  readAgentComposerHistoryCache,
  subscribeAgentComposerHistoryCache,
  writeAgentComposerHistoryCache
} from './agent-composer-history-cache'
import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  clearScopeCachePinsForTests
} from './agent-composer-scope-cache'

afterEach(() => {
  clearAgentComposerHistoryCacheForTests()
  clearScopeCachePinsForTests()
})

describe('agent composer history cache subscriptions', () => {
  it('a subscribed scope survives eviction pressure from cache churn', () => {
    writeAgentComposerHistoryCache('pane-live', pushHistory(EMPTY_HISTORY, 'keep me'))
    const unsubscribe = subscribeAgentComposerHistoryCache('pane-live', () => {})
    for (let i = 0; i < NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 10; i += 1) {
      writeAgentComposerHistoryCache(`pane-churn-${i}`, pushHistory(EMPTY_HISTORY, `entry ${i}`))
    }
    expect(readAgentComposerHistoryCache('pane-live').entries).toEqual(['keep me'])
    unsubscribe()
  })

  it('notifies a new subscriber with the current value immediately', () => {
    writeAgentComposerHistoryCache('pane-1', pushHistory(EMPTY_HISTORY, 'first'))
    const received: (readonly string[])[] = []
    subscribeAgentComposerHistoryCache('pane-1', (history) => received.push(history.entries))
    expect(received).toEqual([['first']])
  })

  it('notifies every live subscriber on write', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeAgentComposerHistoryCache('pane-2', a)
    subscribeAgentComposerHistoryCache('pane-2', b)
    a.mockClear()
    b.mockClear()

    writeAgentComposerHistoryCache('pane-2', pushHistory(EMPTY_HISTORY, 'x'))

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing subscriber does not prevent other subscribers from being notified', () => {
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()
    subscribeAgentComposerHistoryCache('pane-3', throwing)
    subscribeAgentComposerHistoryCache('pane-3', ok)
    throwing.mockClear()
    ok.mockClear()

    expect(() =>
      writeAgentComposerHistoryCache('pane-3', pushHistory(EMPTY_HISTORY, 'y'))
    ).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops further notifications', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAgentComposerHistoryCache('pane-4', listener)
    listener.mockClear()
    unsubscribe()

    writeAgentComposerHistoryCache('pane-4', pushHistory(EMPTY_HISTORY, 'z'))

    expect(listener).not.toHaveBeenCalled()
  })
})
