import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../shared/native-chat-types'
import {
  createNativeChatOutbox,
  drainNativeChatOutbox,
  pushNativeChatAppend,
  pushNativeChatSnapshot,
  resolveNativeChatReplacePending
} from './native-chat-outbox'

function message(id: string, text = 'hi'): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('native chat relay outbox', () => {
  it('drains a snapshot then reports nothing more', () => {
    const outbox = createNativeChatOutbox()
    pushNativeChatSnapshot(outbox, { kind: 'snapshot', messages: [message('a')], hasMore: false })

    const drain = drainNativeChatOutbox(outbox)

    expect(drain.frames).toHaveLength(1)
    expect(drain.frames[0]!.kind).toBe('snapshot')
    expect(drain.more).toBe(false)
    expect(drainNativeChatOutbox(outbox).frames).toEqual([])
  })

  it('coalesces consecutive appends so a fast stream cannot exhaust the frame bound', () => {
    const outbox = createNativeChatOutbox()
    pushNativeChatAppend(outbox, [message('a')])
    pushNativeChatAppend(outbox, [message('b')])
    pushNativeChatAppend(outbox, [message('c')])

    const drain = drainNativeChatOutbox(outbox)

    expect(drain.frames).toHaveLength(1)
    expect(drain.frames[0]!.messages.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('lets a snapshot supersede everything buffered before it', () => {
    const outbox = createNativeChatOutbox()
    pushNativeChatAppend(outbox, [message('stale')])
    pushNativeChatSnapshot(outbox, {
      kind: 'replace',
      messages: [message('fresh')],
      hasMore: false
    })

    const drain = drainNativeChatOutbox(outbox)

    expect(drain.frames).toHaveLength(1)
    expect(drain.frames[0]!.messages.map((m) => m.id)).toEqual(['fresh'])
  })

  it('advances seq on every mutation so the client can detect it is behind', () => {
    const outbox = createNativeChatOutbox()
    expect(outbox.seq).toBe(0)

    pushNativeChatAppend(outbox, [message('a')])
    pushNativeChatSnapshot(outbox, { kind: 'snapshot', messages: [message('b')], hasMore: false })

    expect(outbox.seq).toBe(2)
  })

  // Unbounded buffering against a slow puller is the failure this guards; the
  // watcher already degrades a rotated file the same way.
  it('collapses to a pending re-read when the buffer outgrows its bound', () => {
    const outbox = createNativeChatOutbox()
    for (let i = 0; i < 100 && !outbox.replacePending; i++) {
      pushNativeChatAppend(outbox, [message(`m${i}`, 'x'.repeat(100_000))])
    }

    expect(outbox.replacePending).toBe(true)
    expect(outbox.frames).toEqual([])
  })

  it('reports replacePending to the drain instead of returning stale frames', () => {
    const outbox = createNativeChatOutbox()
    outbox.replacePending = true

    const drain = drainNativeChatOutbox(outbox)

    expect(drain.replacePending).toBe(true)
    expect(drain.frames).toEqual([])

    resolveNativeChatReplacePending(outbox)
    expect(outbox.replacePending).toBe(false)
  })

  // The watcher advances past these lines, so a re-read that raced ahead of the
  // append would lose the turn outright; the client dedups the overlap by id.
  it('buffers appends that arrive while a re-read is pending', () => {
    const outbox = createNativeChatOutbox()
    outbox.replacePending = true

    pushNativeChatAppend(outbox, [message('a')])

    expect(outbox.replacePending).toBe(true)
    expect(drainNativeChatOutbox(outbox).frames).toEqual([])

    resolveNativeChatReplacePending(outbox)
    const drain = drainNativeChatOutbox(outbox)
    expect(drain.frames.map((f) => f.kind)).toEqual(['append'])
    expect(drain.frames[0]!.messages.map((m) => m.id)).toEqual(['a'])
  })

  it('splits a drain across pulls when the frames exceed one budget', () => {
    const outbox = createNativeChatOutbox()
    pushNativeChatSnapshot(outbox, {
      kind: 'snapshot',
      messages: [message('a', 'x'.repeat(4_000))],
      hasMore: false
    })
    pushNativeChatAppend(outbox, [message('b', 'y'.repeat(4_000))])

    const first = drainNativeChatOutbox(outbox, 5_000)

    expect(first.frames.map((f) => f.kind)).toEqual(['snapshot'])
    expect(first.more).toBe(true)

    const second = drainNativeChatOutbox(outbox, 5_000)
    expect(second.frames.map((f) => f.kind)).toEqual(['append'])
    expect(second.more).toBe(false)
  })

  // Without this the pull loop would spin forever on a frame that never fits.
  it('always yields at least one frame even when it exceeds the budget', () => {
    const outbox = createNativeChatOutbox()
    pushNativeChatAppend(outbox, [message('big', 'x'.repeat(50_000))])

    const drain = drainNativeChatOutbox(outbox, 100)

    expect(drain.frames).toHaveLength(1)
  })

  // An over-budget response fails its own request, and the frame has already
  // left the buffer by then — the turns it carried would be gone.
  it('splits a coalesced append that outgrew the budget instead of shipping it whole', () => {
    const outbox = createNativeChatOutbox()
    pushNativeChatAppend(outbox, [message('a', 'x'.repeat(3_000))])
    pushNativeChatAppend(outbox, [message('b', 'y'.repeat(3_000))])
    pushNativeChatAppend(outbox, [message('c', 'z'.repeat(3_000))])

    const first = drainNativeChatOutbox(outbox, 4_000)
    expect(first.frames).toHaveLength(1)
    expect(first.frames[0]!.messages.map((m) => m.id)).toEqual(['a'])
    expect(first.more).toBe(true)

    const second = drainNativeChatOutbox(outbox, 4_000)
    expect(second.frames[0]!.messages.map((m) => m.id)).toEqual(['b'])

    const third = drainNativeChatOutbox(outbox, 4_000)
    expect(third.frames[0]!.messages.map((m) => m.id)).toEqual(['c'])
    expect(third.more).toBe(false)
  })
})
