import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import type { NativeChatCompanionFrameFields } from '../../shared/fork-native-chat-session-options/native-chat-transcript-companion'

// notFound marks a not-yet-on-disk miss (retry-worthy) vs a real read/parse error (#8401).
export type NativeChatReadSessionResult =
  | (NativeChatCompanionFrameFields & {
      messages: NativeChatMessage[]
      /** Authoritative "older history exists". Optional: a runtime old enough to
       *  omit it leaves the caller inferring from the returned count, which is
       *  wrong whenever a read is bounded by bytes rather than turns. */
      hasMore?: boolean
      /** Byte offset of the oldest returned turn — pass it back as
       *  `beforeOffset` to read the page immediately older. Optional for the
       *  same old-runtime reason as `hasMore`; without it the caller can only
       *  page by growing `limit`. */
      beforeOffset?: number
    })
  | { error: string; notFound?: true }

/** Messages appended to a live-tailed transcript since the previous emit. */
export type NativeChatAppendedMessages = NativeChatMessage[]

export type NativeChatSubscriptionFrame = NativeChatCompanionFrameFields &
  (
    | {
        type: 'snapshot'
        messages: NativeChatMessage[]
        hasMore: boolean
        /** Oldest returned turn's byte offset; seeds pagination from a live
         *  snapshot, which otherwise supersedes the seed read that carried it. */
        beforeOffset?: number
        error?: string
        /** No transcript exists behind this window yet — render it, but do not
         *  treat it as a settled read of the session's history. */
        pending?: boolean
      }
    | {
        type: 'replacement'
        messages: NativeChatMessage[]
        hasMore: boolean
        beforeOffset?: number
      }
    | { type: 'appended'; messages: NativeChatMessage[] }
  )

/** Wire payload for the `nativeChat:appended` push channel. */
export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: NativeChatSubscriptionFrame
}

export type NativeChatSubscribeArgs = {
  /** Unique per-caller id, echoed on every append so multiple live panes in
   *  one renderer don't cross-talk. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** First snapshot size; later readSession calls grow this for pagination. */
  limit?: number
  /** Plain-`ssh:` owner of the pane, when it has one — the watcher then lives on
   *  that host's relay and main forwards its frames. */
  sshConnectionId?: string
}

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** How many of the most-recent turns to return. */
  limit?: number
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** Plain-`ssh:` owner of the pane, when it has one — the read then runs on
   *  that host's relay, since this process cannot see its disk. */
  sshConnectionId?: string
  /** Read the window ending at this byte offset instead of the file's tail —
   *  a prior result's `beforeOffset`, which pages older history. */
  beforeOffset?: number
}

export type NativeChatApi = {
  /** Read the on-disk transcript for an agent + session id, windowed to the most recent `limit`
   *  turns. `transcriptPath` is the hook-reported authoritative path, preferred over the id glob. */
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string
  ) => Promise<NativeChatReadSessionResult>
  /** Live-tail a transcript. The first frame is a bounded race-safe snapshot;
   *  later frames contain only newly appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
}
