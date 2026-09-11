import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatRelayPing } from '../../../shared/fork-native-chat-relay/native-chat-relay-protocol'
import {
  readSshNativeChatSession,
  subscribeSshNativeChatTranscript
} from './ssh-transcript-transport'
import type { NativeChatRelayFrame, SshNativeChatRelay } from './ssh-transcript-relay-contract'

function message(id: string) {
  return {
    id,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: id }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function createRelayDouble(responses: Record<string, unknown[]> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const pingHandlers: ((ping: NativeChatRelayPing) => void)[] = []
  const readyHandlers: (() => void)[] = []
  const queues = new Map<string, unknown[]>(Object.entries(responses))
  let failNext = false

  const relay: SshNativeChatRelay = {
    request: async (_connectionId, method, params) => {
      calls.push({ method, params })
      if (failNext) {
        failNext = false
        throw new Error('SSH relay is not ready')
      }
      const queue = queues.get(method)
      return queue && queue.length > 0 ? queue.shift() : { ok: true }
    },
    onChanged: (_connectionId, handler) => {
      pingHandlers.push(handler)
      return () => {
        const index = pingHandlers.indexOf(handler)
        if (index !== -1) {
          pingHandlers.splice(index, 1)
        }
      }
    },
    onRelayReady: (_connectionId, handler) => {
      readyHandlers.push(handler)
      return () => {
        const index = readyHandlers.indexOf(handler)
        if (index !== -1) {
          readyHandlers.splice(index, 1)
        }
      }
    }
  }

  return {
    relay,
    calls,
    ping: (subscriptionId: string, seq: number) => {
      for (const handler of pingHandlers.slice()) {
        handler({ subscriptionId, seq })
      }
    },
    relayReady: () => {
      for (const handler of readyHandlers.slice()) {
        handler()
      }
    },
    setResponses: (method: string, values: unknown[]) => queues.set(method, values),
    failNextRequest: () => {
      failNext = true
    },
    pingHandlerCount: () => pingHandlers.length,
    readyHandlerCount: () => readyHandlers.length
  }
}

const SUBSCRIBE_ARGS = {
  connectionId: 'conn-1',
  subscriptionId: 'sub-1',
  agent: 'claude' as const,
  sessionId: 'session-1'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('readSshNativeChatSession', () => {
  it('returns the relay result unchanged', async () => {
    const harness = createRelayDouble({
      'nativeChat.readSession': [{ messages: [message('a')], hasMore: true, beforeOffset: 12 }]
    })

    const result = await readSshNativeChatSession(harness.relay, {
      connectionId: 'conn-1',
      agent: 'claude',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ messages: [message('a')], hasMore: true, beforeOffset: 12 })
  })

  // A relay that is down has not proven the transcript is missing; a hard error
  // would strand the pane instead of letting the renderer keep retrying.
  it('marks a relay failure retry-worthy rather than terminal', async () => {
    const harness = createRelayDouble()
    harness.failNextRequest()

    const result = await readSshNativeChatSession(harness.relay, {
      connectionId: 'conn-1',
      agent: 'claude',
      sessionId: 'session-1'
    })

    expect(result).toMatchObject({ notFound: true })
  })
})

describe('subscribeSshNativeChatTranscript', () => {
  it('subscribes and pulls the buffered snapshot without waiting for a ping', async () => {
    const frames: NativeChatRelayFrame[] = []
    const harness = createRelayDouble({
      'nativeChat.pull': [
        { frames: [{ kind: 'snapshot', messages: [message('a')], hasMore: false }], more: false }
      ]
    })

    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, (frame) => frames.push(frame))
    await vi.waitFor(() => expect(frames).toHaveLength(1))

    expect(harness.calls.map((c) => c.method)).toEqual(['nativeChat.subscribe', 'nativeChat.pull'])
    expect(frames[0]!.kind).toBe('snapshot')
  })

  it('pulls again when a ping arrives', async () => {
    const frames: NativeChatRelayFrame[] = []
    const harness = createRelayDouble({
      'nativeChat.pull': [
        { frames: [], more: false },
        { frames: [{ kind: 'append', messages: [message('b')] }], more: false }
      ]
    })

    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, (frame) => frames.push(frame))
    await vi.waitFor(() =>
      expect(harness.calls.filter((c) => c.method === 'nativeChat.pull')).toHaveLength(1)
    )

    harness.ping('sub-1', 2)

    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames[0]!.messages.map((m) => m.id)).toEqual(['b'])
  })

  it('ignores a ping for a different subscription', async () => {
    const harness = createRelayDouble({ 'nativeChat.pull': [{ frames: [], more: false }] })
    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, () => {})
    await vi.waitFor(() =>
      expect(harness.calls.filter((c) => c.method === 'nativeChat.pull')).toHaveLength(1)
    )

    harness.ping('someone-else', 9)

    expect(harness.calls.filter((c) => c.method === 'nativeChat.pull')).toHaveLength(1)
  })

  it('keeps pulling while the relay reports more', async () => {
    const frames: NativeChatRelayFrame[] = []
    const harness = createRelayDouble({
      'nativeChat.pull': [
        { frames: [{ kind: 'append', messages: [message('a')] }], more: true },
        { frames: [{ kind: 'append', messages: [message('b')] }], more: false }
      ]
    })

    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, (frame) => frames.push(frame))

    await vi.waitFor(() => expect(frames).toHaveLength(2))
  })

  it('resubscribes after the relay forgets the subscription', async () => {
    vi.useFakeTimers()
    const harness = createRelayDouble({ 'nativeChat.pull': [{ unknownSubscription: true }] })

    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, () => {})
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(2_500)

    expect(harness.calls.filter((c) => c.method === 'nativeChat.subscribe').length).toBeGreaterThan(
      1
    )
  })

  it('retries after a failed subscribe', async () => {
    vi.useFakeTimers()
    const harness = createRelayDouble()
    harness.failNextRequest()

    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, () => {})
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(2_500)

    expect(harness.calls.filter((c) => c.method === 'nativeChat.subscribe').length).toBeGreaterThan(
      1
    )
  })

  it('stops pulling and releases the ping listener on unsubscribe', async () => {
    const harness = createRelayDouble({ 'nativeChat.pull': [{ frames: [], more: false }] })
    const subscription = subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, () => {})
    await vi.waitFor(() => expect(harness.pingHandlerCount()).toBe(1))

    subscription.unsubscribe()

    expect(harness.pingHandlerCount()).toBe(0)
    expect(harness.readyHandlerCount()).toBe(0)
    expect(harness.calls.some((c) => c.method === 'nativeChat.unsubscribe')).toBe(true)
  })

  // The relay reaps a client's subscriptions when its connection detaches. An
  // idle pane issues no request, so nothing else would ever notice.
  it('resubscribes when the relay reaches ready again', async () => {
    const harness = createRelayDouble({ 'nativeChat.pull': [{ frames: [], more: false }] })
    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, () => {})
    await vi.waitFor(() =>
      expect(harness.calls.filter((c) => c.method === 'nativeChat.subscribe')).toHaveLength(1)
    )

    harness.relayReady()

    await vi.waitFor(() =>
      expect(harness.calls.filter((c) => c.method === 'nativeChat.subscribe')).toHaveLength(2)
    )
  })

  // The ping listener binds to the connection's current channel, which a
  // reconnect replaces; leaving the old one armed would deafen the pane.
  it('re-arms exactly one ping listener across a reconnect', async () => {
    const harness = createRelayDouble({ 'nativeChat.pull': [{ frames: [], more: false }] })
    subscribeSshNativeChatTranscript(harness.relay, SUBSCRIBE_ARGS, () => {})
    await vi.waitFor(() => expect(harness.pingHandlerCount()).toBe(1))

    harness.relayReady()

    await vi.waitFor(() =>
      expect(harness.calls.filter((c) => c.method === 'nativeChat.subscribe')).toHaveLength(2)
    )
    expect(harness.pingHandlerCount()).toBe(1)
  })

  it('forwards beforeOffset when paging older history', async () => {
    const harness = createRelayDouble({
      'nativeChat.readSession': [{ messages: [message('a')], hasMore: false, beforeOffset: 0 }]
    })

    await readSshNativeChatSession(harness.relay, {
      connectionId: 'conn-1',
      agent: 'claude',
      sessionId: 'session-1',
      limit: 200,
      beforeOffset: 4096
    })

    expect(harness.calls[0]!.params).toMatchObject({ limit: 200, beforeOffset: 4096 })
  })
})
