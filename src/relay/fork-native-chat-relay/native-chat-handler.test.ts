import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatHandler } from './native-chat-handler'
import { NATIVE_CHAT_CHANGED_METHOD } from '../../shared/fork-native-chat-relay/native-chat-relay-protocol'
import type { RelayDispatcher } from '../dispatcher'

type Handler = (params: Record<string, unknown>, context: { clientId: number }) => Promise<unknown>

type Ping = { clientId: number; method: string; params: Record<string, unknown> }

/** Minimal dispatcher double: records pings and lets a test reject admission. */
function createDispatcherDouble() {
  const handlers = new Map<string, Handler>()
  const pings: Ping[] = []
  const capacityListeners = new Map<number, () => void>()
  let detach: ((clientId: number) => void) | undefined
  let admit = true

  const dispatcher = {
    onRequest: (method: string, handler: Handler) => handlers.set(method, handler),
    onClientDetached: (listener: (clientId: number) => void) => {
      detach = listener
      return () => {}
    },
    notificationFrameBytes: () => 100,
    tryNotifyClient: (
      clientId: number,
      method: string,
      params: Record<string, unknown>,
      onSettled: (result: { ok: boolean }) => void
    ) => {
      if (!admit) {
        return false
      }
      pings.push({ clientId, method, params })
      onSettled({ ok: true })
      return true
    },
    onClientCapacity: (clientId: number, listener: () => void) => {
      capacityListeners.set(clientId, listener)
      return () => capacityListeners.delete(clientId)
    }
  } as unknown as RelayDispatcher

  return {
    dispatcher,
    pings,
    call: (method: string, params: Record<string, unknown>, clientId = 1) =>
      handlers.get(method)!(params, { clientId }),
    detachClient: (clientId: number) => detach?.(clientId),
    fireCapacity: (clientId: number) => capacityListeners.get(clientId)?.(),
    setAdmit: (value: boolean) => {
      admit = value
    },
    hasCapacityListener: (clientId: number) => capacityListeners.has(clientId)
  }
}

const CLAUDE_LINE = (id: string, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`

describe('NativeChatHandler', () => {
  let dir: string
  let transcript: string
  let harness: ReturnType<typeof createDispatcherDouble>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-native-chat-relay-'))
    transcript = join(dir, 'session.jsonl')
    harness = createDispatcherDouble()
    new NativeChatHandler(harness.dispatcher)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reads a windowed session tail', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello') + CLAUDE_LINE('m2', 'world'))

    const result = (await harness.call('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })) as { messages: { blocks: { text?: string }[] }[] }

    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]!.blocks[0]!.text).toBe('world')
  })

  it('rejects a read with no agent or session id', async () => {
    expect(await harness.call('nativeChat.readSession', {})).toEqual({
      error: 'Missing agent or session id'
    })
  })

  it('pings after the initial snapshot and serves it on pull', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))

    await harness.call('nativeChat.subscribe', {
      subscriptionId: 'sub-1',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })
    await vi.waitFor(() => expect(harness.pings.length).toBeGreaterThan(0))

    expect(harness.pings[0]!.method).toBe(NATIVE_CHAT_CHANGED_METHOD)
    expect(harness.pings[0]!.params.subscriptionId).toBe('sub-1')

    const pull = (await harness.call('nativeChat.pull', { subscriptionId: 'sub-1' })) as {
      frames: { kind: string; messages: unknown[] }[]
      more: boolean
    }
    expect(pull.frames[0]!.kind).toBe('snapshot')
    expect(pull.frames[0]!.messages).toHaveLength(1)
    expect(pull.more).toBe(false)
  })

  it('delivers appended turns on a later pull', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))
    await harness.call('nativeChat.subscribe', {
      subscriptionId: 'sub-1',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })
    await vi.waitFor(() => expect(harness.pings.length).toBeGreaterThan(0))
    await harness.call('nativeChat.pull', { subscriptionId: 'sub-1' })

    appendFileSync(transcript, CLAUDE_LINE('m2', 'later'))

    await vi.waitFor(
      async () => {
        const pull = (await harness.call('nativeChat.pull', { subscriptionId: 'sub-1' })) as {
          frames: { kind: string; messages: unknown[] }[]
        }
        expect(pull.frames.length).toBeGreaterThan(0)
      },
      { timeout: 5_000 }
    )
  })

  it('reports an unknown subscription instead of throwing', async () => {
    expect(await harness.call('nativeChat.pull', { subscriptionId: 'nope' })).toMatchObject({
      unknownSubscription: true
    })
  })

  // The ping is the only push in the design; a dropped one with no retry would
  // strand the pane exactly the way the bug this work started from did.
  it('retains a rejected ping and re-sends it when capacity frees up', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))
    harness.setAdmit(false)

    await harness.call('nativeChat.subscribe', {
      subscriptionId: 'sub-1',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })
    await vi.waitFor(() => expect(harness.hasCapacityListener(1)).toBe(true))
    expect(harness.pings).toHaveLength(0)

    harness.setAdmit(true)
    harness.fireCapacity(1)

    expect(harness.pings.length).toBeGreaterThan(0)
  })

  it("reaps a client's subscriptions when it detaches", async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))
    await harness.call('nativeChat.subscribe', {
      subscriptionId: 'sub-1',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })

    harness.detachClient(1)

    expect(await harness.call('nativeChat.pull', { subscriptionId: 'sub-1' })).toMatchObject({
      unknownSubscription: true
    })
  })

  it('releases the capacity listener once no ping is waiting', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))
    harness.setAdmit(false)
    await harness.call('nativeChat.subscribe', {
      subscriptionId: 'sub-1',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })
    await vi.waitFor(() => expect(harness.hasCapacityListener(1)).toBe(true))

    harness.setAdmit(true)
    harness.fireCapacity(1)

    expect(harness.hasCapacityListener(1)).toBe(false)
  })

  it('releases the capacity listener when the subscription goes away', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))
    harness.setAdmit(false)
    await harness.call('nativeChat.subscribe', {
      subscriptionId: 'sub-1',
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript
    })
    await vi.waitFor(() => expect(harness.hasCapacityListener(1)).toBe(true))

    await harness.call('nativeChat.unsubscribe', { subscriptionId: 'sub-1' })

    expect(harness.hasCapacityListener(1)).toBe(false)
  })

  // Paging back needs an offset that describes what actually came back; the
  // budget is applied during the read so the two cannot disagree.
  it('reports a beforeOffset that matches the messages it returned', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'first') + CLAUDE_LINE('m2', 'second'))

    const page = (await harness.call('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript,
      limit: 1
    })) as { messages: unknown[]; hasMore: boolean; beforeOffset: number }

    expect(page.messages).toHaveLength(1)
    expect(page.hasMore).toBe(true)

    const older = (await harness.call('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: transcript,
      limit: 1,
      beforeOffset: page.beforeOffset
    })) as { messages: { blocks: { text?: string }[] }[]; hasMore: boolean }

    expect(older.messages).toHaveLength(1)
    expect(older.messages[0]!.blocks[0]!.text).toBe('first')
    expect(older.hasMore).toBe(false)
  })

  it('scopes subscription ids per client', async () => {
    writeFileSync(transcript, CLAUDE_LINE('m1', 'hello'))
    await harness.call(
      'nativeChat.subscribe',
      {
        subscriptionId: 'sub-1',
        agent: 'claude',
        sessionId: 'session',
        transcriptPath: transcript
      },
      1
    )

    expect(await harness.call('nativeChat.pull', { subscriptionId: 'sub-1' }, 2)).toMatchObject({
      unknownSubscription: true
    })
  })
})
