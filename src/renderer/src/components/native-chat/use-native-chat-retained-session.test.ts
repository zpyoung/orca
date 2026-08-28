// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  NativeChatLiveSession,
  UseNativeChatLiveSessionArgs
} from './fork-native-chat-relay/use-native-chat-live-session'

const { liveSession } = vi.hoisted(() => ({ liveSession: vi.fn() }))

vi.mock('./fork-native-chat-relay/use-native-chat-live-session', () => ({
  useNativeChatLiveSession: liveSession,
  isNativeChatTranscriptUnsettled: (phase: string) => phase === 'loading' || phase === 'awaiting'
}))

import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { selectNativeChatViewState } from './fork-native-chat-relay/native-chat-view-state'

const ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab:leaf',
  agent: 'claude',
  sessionId: 'session',
  runtimeEnvironmentId: 'owner-a'
}

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [], timestamp: 0, source: 'transcript' }
}

function session(
  readPhase: NativeChatLiveSession['readPhase'],
  messages: NativeChatMessage[],
  sessionId: string | null = 'session',
  status: NativeChatLiveSession['status'] = readPhase === 'loading' ? 'loading' : 'ready'
): NativeChatLiveSession {
  return {
    agent: 'claude',
    sessionId,
    messages,
    status,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase
  }
}

describe('useNativeChatRetainedSession', () => {
  let root: Root | null = null
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatRetainedSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<void> {
    if (!root) {
      root = createRoot(document.createElement('div'))
    }
    await act(async () => root?.render(createElement(Probe, props)))
  }

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    latest = null
    liveSession.mockReset()
  })

  it('keeps settled messages during a same-identity rebind', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('loading', []))
    await render(ARGS)

    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
  })

  it('misses retained messages when the source owner changes', async () => {
    liveSession.mockReturnValue(session('ready', [message('owner-a')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('loading', []))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages).toEqual([])
  })

  // Two ssh hosts can hand back the same agent session id, so the connection is
  // part of the identity — otherwise host B renders host A's conversation.
  it('misses retained messages when the ssh connection changes', async () => {
    const onHostA = { ...ARGS, runtimeEnvironmentId: null, sshConnectionId: 'ssh:host-a' }
    liveSession.mockReturnValue(session('ready', [message('from-host-a')]))
    await render(onHostA)

    liveSession.mockReturnValue(session('loading', []))
    await render({ ...onHostA, sshConnectionId: 'ssh:host-b' })

    expect(latest?.messages).toEqual([])
  })

  // The live hook deliberately surfaces subscribe appends over a spinner while the
  // base read retries a not-yet-flushed transcript; retention must not undo that.
  it('keeps live appends visible while the base read is still retrying', async () => {
    liveSession.mockReturnValue(session('loading', [message('appended')], 'session', 'working'))
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['appended'])
    expect(selectNativeChatViewState(latest!).kind).toBe('ready')
  })

  it('keeps live appends visible when the base read errored', async () => {
    liveSession.mockReturnValue(session('error', [message('appended')], 'session', 'working'))
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['appended'])
    expect(selectNativeChatViewState(latest!).kind).toBe('ready')
  })

  it('keeps the hook status while a retained list is visible', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('loading', [], 'session', 'working'))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
    expect(latest?.status).toBe('working')
  })

  // The identity ref advances in an effect while the live hook's reset is a queued
  // update, so a render can see a matching identity over the old source's list.
  it('does not serve the previous source list before the live hook resets', async () => {
    liveSession.mockReturnValue(session('ready', [message('owner-a')]))
    await render(ARGS)

    // owner-b is the requested identity, but the live hook has not re-read yet: it
    // still carries owner-a's appends on an unsettled read. The second render is the
    // dangerous one — the identity ref has advanced, so the identities now match.
    liveSession.mockReturnValue(session('loading', [message('owner-a')], 'session', 'working'))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.messages).toEqual([])

    // Once the live hook resets and owner-b's own turns arrive, they render.
    liveSession.mockReturnValue(session('loading', [], 'session', 'working'))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })
    liveSession.mockReturnValue(session('loading', [message('owner-b')], 'session', 'working'))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['owner-b'])
  })

  // Same race, but the stale read still reports 'ready'. retention.visible() hands
  // back a settled list verbatim, so the phase must be withheld too, not just the list.
  it('does not serve a stale settled list before the live hook resets', async () => {
    liveSession.mockReturnValue(session('ready', [message('owner-a')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('ready', [message('owner-a')]))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.messages).toEqual([])
    expect(latest?.readPhase).toBe('loading')

    // A stale 'ready' render must not be captured either, or retention replays the
    // previous source's turns under this identity for the rest of the pane's life.
    liveSession.mockReturnValue(session('loading', [], 'session', 'working'))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.messages).toEqual([])
  })

  // selectNativeChatViewState treats 'error' as terminal, so it beats the retained
  // list; a rebind must not paint the previous source's error over this one.
  it('drops the previous source error when replaying a retained list', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue({
      ...session('error', [], 'session', 'error'),
      error: 'owner-b transcript unreadable'
    })
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
    expect(latest?.error).toBeUndefined()
    expect(selectNativeChatViewState(latest!).kind).toBe('ready')
  })

  // Guards the empty-flash regression: a rebind with nothing retained must still
  // hold the loading surface rather than falling through to the empty state.
  it('forces the loading surface when a rebind has nothing to show', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('ready', [], 'other', 'ready'))
    await render({ ...ARGS, sessionId: 'other' })

    expect(latest?.status).toBe('loading')
    expect(selectNativeChatViewState(latest!).kind).toBe('loading')
  })

  it('does not overwrite retention with the session-less view', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('ready', [], null))
    await render({ ...ARGS, sessionId: null })
    liveSession.mockReturnValue(session('loading', []))
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
  })
})
