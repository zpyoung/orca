// Reads and tails an agent transcript that lives on a plain `ssh:` host.
//
// The local readers cannot see that disk, so the work runs on the relay and this
// adapter mirrors the local subscribe contract: the relay pushes only a ping,
// and every payload is pulled over request/response, where an oversized frame
// fails its own request instead of being silently dropped.

import {
  NATIVE_CHAT_RELAY_PULL_METHOD,
  NATIVE_CHAT_RELAY_READ_SESSION_METHOD,
  NATIVE_CHAT_RELAY_SUBSCRIBE_METHOD,
  NATIVE_CHAT_RELAY_UNSUBSCRIBE_METHOD
} from '../../../shared/fork-native-chat-relay/native-chat-relay-protocol'
import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import type { ReadTranscriptResult } from '../transcript-reader'
import type { NativeChatRelayFrame, SshNativeChatRelay } from './ssh-transcript-relay-contract'

export type { NativeChatRelayFrame, SshNativeChatRelay } from './ssh-transcript-relay-contract'

// A dropped connection resubscribes; the fresh snapshot re-seeds the pane, which
// merges by id, so no turn is duplicated.
const RECONNECT_DELAY_MS = 2_000

export type SshNativeChatSubscribeArgs = {
  connectionId: string
  subscriptionId: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  limit?: number
}

export async function readSshNativeChatSession(
  relay: SshNativeChatRelay,
  args: {
    connectionId: string
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    limit?: number
    beforeOffset?: number
  }
): Promise<ReadTranscriptResult> {
  try {
    const result = (await relay.request(args.connectionId, NATIVE_CHAT_RELAY_READ_SESSION_METHOD, {
      agent: args.agent,
      sessionId: args.sessionId,
      ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.beforeOffset !== undefined ? { beforeOffset: args.beforeOffset } : {})
    })) as ReadTranscriptResult | null
    if (!result || typeof result !== 'object') {
      return { error: 'Transcript unavailable', notFound: true }
    }
    return result
  } catch (error) {
    // Why: a relay that is down or reconnecting has not proven the transcript is
    // missing, so keep the miss retry-worthy rather than settling a hard error.
    return {
      error: error instanceof Error ? error.message : String(error),
      notFound: true
    }
  }
}

export type SshNativeChatSubscription = { unsubscribe: () => void }

/**
 * Subscribe to a remote transcript. `onFrame` receives the same frame shapes the
 * local watcher emits, so callers downstream cannot tell the two apart.
 */
export function subscribeSshNativeChatTranscript(
  relay: SshNativeChatRelay,
  args: SshNativeChatSubscribeArgs,
  onFrame: (frame: NativeChatRelayFrame) => void
): SshNativeChatSubscription {
  let closed = false
  let pingCleanup: (() => void) | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pulling = false
  let pullRequested = false
  // Guards a slow open against a newer one started by a reconnect or ready signal.
  let openGeneration = 0

  const subscribeParams = {
    subscriptionId: args.subscriptionId,
    agent: args.agent,
    sessionId: args.sessionId,
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
    ...(args.limit ? { limit: args.limit } : {})
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) {
      return
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void open()
    }, RECONNECT_DELAY_MS)
    reconnectTimer.unref?.()
  }

  /** Drain the relay's outbox. Coalesced: a ping during a pull queues one more. */
  async function pull(): Promise<void> {
    if (closed || pulling) {
      pullRequested = !closed
      return
    }
    pulling = true
    try {
      let more = true
      while (more && !closed) {
        const result = (await relay.request(args.connectionId, NATIVE_CHAT_RELAY_PULL_METHOD, {
          subscriptionId: args.subscriptionId
        })) as { frames?: NativeChatRelayFrame[]; more?: boolean; unknownSubscription?: boolean }
        if (result?.unknownSubscription) {
          // The relay lost our state (restart); re-establish rather than idle.
          scheduleReconnect()
          return
        }
        for (const frame of result?.frames ?? []) {
          if (!closed) {
            onFrame(frame)
          }
        }
        more = result?.more === true
      }
    } catch {
      scheduleReconnect()
    } finally {
      pulling = false
      if (pullRequested && !closed) {
        pullRequested = false
        void pull()
      }
    }
  }

  async function open(): Promise<void> {
    if (closed) {
      return
    }
    const generation = ++openGeneration
    // Re-armed per open: the listener binds to the connection's current channel,
    // which a reconnect replaces.
    pingCleanup?.()
    pingCleanup = relay.onChanged(args.connectionId, (ping) => {
      if (ping.subscriptionId === args.subscriptionId) {
        void pull()
      }
    })
    try {
      await relay.request(args.connectionId, NATIVE_CHAT_RELAY_SUBSCRIBE_METHOD, subscribeParams)
    } catch {
      if (generation === openGeneration) {
        scheduleReconnect()
      }
      return
    }
    if (generation !== openGeneration) {
      return
    }
    // The initial snapshot is already buffered; pull without waiting for a ping
    // so a lost first ping cannot strand the pane on its loading surface.
    void pull()
  }

  // A reconnect reaps the relay-side subscription, and an idle pane makes no
  // request that would surface the loss — re-establish from the ready signal.
  const readyCleanup = relay.onRelayReady(args.connectionId, () => {
    if (closed) {
      return
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    void open()
  })

  void open()

  return {
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      readyCleanup()
      pingCleanup?.()
      pingCleanup = null
      void relay
        .request(args.connectionId, NATIVE_CHAT_RELAY_UNSUBSCRIBE_METHOD, {
          subscriptionId: args.subscriptionId
        })
        .catch(() => {
          // Best effort: a dropped connection already reaped it relay-side.
        })
    }
  }
}

export type { NativeChatMessage }
