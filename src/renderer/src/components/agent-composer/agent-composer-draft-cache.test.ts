import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentComposerDraftCacheForTests,
  readAgentComposerDraftCache,
  subscribeAgentComposerDraftCache,
  writeAgentComposerDraftCache
} from './agent-composer-draft-cache'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './agent-composer-scope-cache'

afterEach(() => {
  clearAgentComposerDraftCacheForTests()
})

describe('agent composer draft cache', () => {
  it('returns an empty string for an unknown scope', () => {
    expect(readAgentComposerDraftCache('pty-1')).toBe('')
  })

  it('round-trips a draft per scope key', () => {
    writeAgentComposerDraftCache('pty-1', 'hello')
    writeAgentComposerDraftCache('pty-2', 'world')
    expect(readAgentComposerDraftCache('pty-1')).toBe('hello')
    expect(readAgentComposerDraftCache('pty-2')).toBe('world')
  })

  it('drops the entry when the draft is cleared so stale text never resurfaces', () => {
    writeAgentComposerDraftCache('pty-1', 'hello')
    writeAgentComposerDraftCache('pty-1', '')
    expect(readAgentComposerDraftCache('pty-1')).toBe('')
  })

  it('bounds the cache so unsent drafts for removed panes cannot accumulate', () => {
    writeAgentComposerDraftCache('keep', 'hot')

    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 40
    for (let i = 0; i < total; i += 1) {
      writeAgentComposerDraftCache(`scope-${i}`, `draft-${i}`)
      if (i % 20 === 0) {
        writeAgentComposerDraftCache('keep', 'hot')
      }
    }

    // Oldest untouched draft evicted; the actively-edited and most-recent survive.
    expect(readAgentComposerDraftCache('scope-0')).toBe('')
    expect(readAgentComposerDraftCache('keep')).toBe('hot')
    expect(readAgentComposerDraftCache(`scope-${total - 1}`)).toBe(`draft-${total - 1}`)
  })
})

describe('agent composer draft cache subscriptions', () => {
  it('notifies a new subscriber with the current value immediately', () => {
    writeAgentComposerDraftCache('pane-1', 'hello')
    const received: string[] = []
    subscribeAgentComposerDraftCache('pane-1', (draft) => received.push(draft))
    expect(received).toEqual(['hello'])
  })

  it('notifies every live subscriber on write', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeAgentComposerDraftCache('pane-2', a)
    subscribeAgentComposerDraftCache('pane-2', b)
    a.mockClear()
    b.mockClear()

    writeAgentComposerDraftCache('pane-2', 'x')

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing subscriber does not prevent other subscribers from being notified', () => {
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()
    subscribeAgentComposerDraftCache('pane-3', throwing)
    subscribeAgentComposerDraftCache('pane-3', ok)
    throwing.mockClear()
    ok.mockClear()

    expect(() => writeAgentComposerDraftCache('pane-3', 'y')).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops further notifications', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAgentComposerDraftCache('pane-4', listener)
    listener.mockClear()
    unsubscribe()

    writeAgentComposerDraftCache('pane-4', 'z')

    expect(listener).not.toHaveBeenCalled()
  })
})
