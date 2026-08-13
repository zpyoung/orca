import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAgentComposerDraftCacheForTests,
  readAgentComposerDraftCache,
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
