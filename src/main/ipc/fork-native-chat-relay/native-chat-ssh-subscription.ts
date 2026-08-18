// Bridges a plain-`ssh:` pane's relay-hosted transcript onto the same IPC
// channel the local watcher uses, so the renderer cannot tell the two apart.

import type { WebContents } from 'electron'
import {
  readSshNativeChatSession,
  subscribeSshNativeChatTranscript
} from '../../native-chat/fork-native-chat-relay/ssh-transcript-transport'
import type {
  NativeChatRelayFrame,
  SshNativeChatRelay
} from '../../native-chat/fork-native-chat-relay/ssh-transcript-relay-contract'
import {
  onActiveSshNativeChatChanged,
  onActiveSshRelayReady,
  requestActiveSshNativeChat
} from '../ssh'
import type { AgentType } from '../../../shared/native-chat-types'
import type { ReadTranscriptResult } from '../../native-chat/transcript-reader'
import type { NativeChatTranscriptSubscription } from '../../native-chat/transcript-watch-contract'

/** Binds the transport to the live SSH relay sessions. Kept as a value so the
 *  transport itself stays testable without one. */
export const sshNativeChatRelay: SshNativeChatRelay = {
  request: (connectionId, method, params) =>
    requestActiveSshNativeChat(connectionId, method, params),
  onChanged: (connectionId, handler) => onActiveSshNativeChatChanged(connectionId, handler),
  onRelayReady: (connectionId, handler) => onActiveSshRelayReady(connectionId, handler)
}

export type NativeChatIpcFrame =
  | {
      type: 'snapshot'
      messages: NativeChatRelayFrame['messages']
      hasMore: boolean
      beforeOffset?: number
      error?: string
      lifecycle?: NativeChatRelayFrame['lifecycle']
    }
  | {
      type: 'replacement'
      messages: NativeChatRelayFrame['messages']
      hasMore: boolean
      beforeOffset?: number
      lifecycle?: NativeChatRelayFrame['lifecycle']
    }
  | {
      type: 'appended'
      messages: NativeChatRelayFrame['messages']
      lifecycle?: NativeChatRelayFrame['lifecycle']
    }

/** Relay frames carry the same content as the local watcher's under wire-side
 *  names; translate rather than teach the renderer a second vocabulary. */
export function toNativeChatIpcFrame(frame: NativeChatRelayFrame): NativeChatIpcFrame {
  if (frame.kind === 'append') {
    return {
      type: 'appended',
      messages: frame.messages,
      ...(frame.lifecycle ? { lifecycle: frame.lifecycle } : {})
    }
  }
  if (frame.kind === 'replace') {
    return {
      type: 'replacement',
      messages: frame.messages,
      hasMore: frame.hasMore,
      ...(typeof frame.beforeOffset === 'number' ? { beforeOffset: frame.beforeOffset } : {}),
      ...(frame.lifecycle ? { lifecycle: frame.lifecycle } : {})
    }
  }
  return {
    type: 'snapshot',
    messages: frame.messages,
    hasMore: frame.hasMore,
    ...(typeof frame.beforeOffset === 'number' ? { beforeOffset: frame.beforeOffset } : {}),
    ...(frame.error ? { error: frame.error } : {}),
    ...(frame.lifecycle ? { lifecycle: frame.lifecycle } : {})
  }
}

export function readSshNativeChatTranscript(args: {
  sshConnectionId: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  limit: number
  beforeOffset?: number
}): Promise<ReadTranscriptResult> {
  return readSshNativeChatSession(sshNativeChatRelay, {
    connectionId: args.sshConnectionId,
    agent: args.agent,
    sessionId: args.sessionId,
    limit: args.limit,
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
    ...(typeof args.beforeOffset === 'number' ? { beforeOffset: args.beforeOffset } : {})
  })
}

export function subscribeSshNativeChatForSender(args: {
  sender: WebContents
  subscriptionId: string
  sshConnectionId: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  limit: number
}): NativeChatTranscriptSubscription {
  const { sender, subscriptionId } = args
  const subscription = subscribeSshNativeChatTranscript(
    sshNativeChatRelay,
    {
      connectionId: args.sshConnectionId,
      subscriptionId,
      agent: args.agent,
      sessionId: args.sessionId,
      limit: args.limit,
      ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {})
    },
    (frame) => {
      if (!sender.isDestroyed()) {
        sender.send('nativeChat:appended', { subscriptionId, frame: toNativeChatIpcFrame(frame) })
      }
    }
  )
  return { watching: true, unsubscribe: subscription.unsubscribe }
}
