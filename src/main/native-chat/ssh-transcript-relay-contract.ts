// The narrow relay surface the ssh transcript transport needs, kept separate
// from the ipc/ssh module so the transport is testable without a live session.

import type { NativeChatRelayPing } from '../../shared/native-chat-relay-protocol'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'

export type NativeChatRelayFrame =
  | {
      kind: 'snapshot' | 'replace'
      messages: NativeChatMessage[]
      hasMore: boolean
      beforeOffset?: number
      lifecycle?: NativeChatTurnLifecycle
      error?: string
    }
  | { kind: 'append'; messages: NativeChatMessage[]; lifecycle?: NativeChatTurnLifecycle }

export type SshNativeChatRelay = {
  request: (
    connectionId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>
  onChanged: (connectionId: string, handler: (ping: NativeChatRelayPing) => void) => () => void
  /** Fires on every relay ready, reconnects included. The relay reaps a client's
   *  subscriptions when its connection detaches, so this is the only signal an
   *  idle pane gets that its watcher is gone. */
  onRelayReady: (connectionId: string, handler: () => void) => () => void
}
