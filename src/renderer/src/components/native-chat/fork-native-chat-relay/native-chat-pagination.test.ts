import { describe, expect, it } from 'vitest'
import {
  hasMoreBeforeNativeChatPage,
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  NATIVE_CHAT_PAGE,
  nextNativeChatLimit,
  nextNativeChatPageRequest,
  resolveNativeChatHasMore
} from './native-chat-pagination'

describe('nextNativeChatLimit', () => {
  it('grows the limit by one page', () => {
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    )
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + 2 * NATIVE_CHAT_PAGE
    )
  })
})

describe('hasMoreNativeChatHistory', () => {
  it('reports more when the read filled the requested window', () => {
    expect(hasMoreNativeChatHistory(300, 300)).toBe(true)
    expect(hasMoreNativeChatHistory(301, 300)).toBe(true)
  })

  it('reports done when the read returned fewer than requested (head reached)', () => {
    expect(hasMoreNativeChatHistory(120, 300)).toBe(false)
    expect(hasMoreNativeChatHistory(0, 300)).toBe(false)
  })
})

describe('resolveNativeChatHasMore', () => {
  it('trusts the reader when it reports one', () => {
    expect(resolveNativeChatHasMore(true, 3, 300)).toBe(true)
    expect(resolveNativeChatHasMore(false, 300, 300)).toBe(false)
  })

  it('falls back to count inference when the reader omits it', () => {
    expect(resolveNativeChatHasMore(undefined, 300, 300)).toBe(true)
    expect(resolveNativeChatHasMore(undefined, 12, 300)).toBe(false)
  })

  // A byte-bounded read (the ssh relay path) returns fewer messages than asked
  // while older history still exists; inference alone retires load-earlier.
  it('keeps load-earlier alive for a byte-bounded short read', () => {
    expect(resolveNativeChatHasMore(true, 8, 300)).toBe(true)
  })
})

describe('nextNativeChatPageRequest', () => {
  // Raising the limit against a byte-bounded reader just re-budgets the same
  // tail, so a known offset has to drive the request instead.
  it('asks for the window before the oldest loaded turn when one is known', () => {
    expect(nextNativeChatPageRequest(NATIVE_CHAT_INITIAL_LIMIT, 4_096)).toEqual({
      mode: 'before',
      limit: NATIVE_CHAT_PAGE,
      beforeOffset: 4_096
    })
  })

  it('grows the limit when the reader reported no offset', () => {
    expect(nextNativeChatPageRequest(NATIVE_CHAT_INITIAL_LIMIT, null)).toEqual({
      mode: 'grow',
      limit: NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    })
  })

  // Offset 0 is the head of the file: there is nothing before it to request.
  it('grows the limit at offset zero rather than re-reading the head', () => {
    expect(nextNativeChatPageRequest(NATIVE_CHAT_INITIAL_LIMIT, 0).mode).toBe('grow')
  })
})

describe('hasMoreBeforeNativeChatPage', () => {
  it('trusts the reader when the offset moved back', () => {
    expect(hasMoreBeforeNativeChatPage(true, 5, 4_096, 2_048)).toBe(true)
    expect(hasMoreBeforeNativeChatPage(false, 5, 4_096, 2_048)).toBe(false)
  })

  // Either would let load-earlier retrigger against the same window forever.
  it('stops on an empty page or an offset that did not move', () => {
    expect(hasMoreBeforeNativeChatPage(true, 0, 4_096, 0)).toBe(false)
    expect(hasMoreBeforeNativeChatPage(true, 5, 4_096, 4_096)).toBe(false)
    expect(hasMoreBeforeNativeChatPage(true, 5, 4_096, undefined)).toBe(false)
  })

  it('falls back to a full page meaning more when the reader omits hasMore', () => {
    expect(hasMoreBeforeNativeChatPage(undefined, NATIVE_CHAT_PAGE, 4_096, 100)).toBe(true)
    expect(hasMoreBeforeNativeChatPage(undefined, 3, 4_096, 100)).toBe(false)
  })
})
