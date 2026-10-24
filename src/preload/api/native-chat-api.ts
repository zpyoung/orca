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

export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: NativeChatSubscriptionFrame
}

export type NativeChatSubscribeArgs = {
  /** Unique per caller to isolate live panes sharing a renderer. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** First snapshot size; later readSession calls grow this for pagination. */
  limit?: number
}

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** How many of the most-recent turns to return. */
  limit?: number
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** Read the window ending at this byte offset instead of the file's tail —
   *  a prior result's `beforeOffset`, which pages older history. */
  beforeOffset?: number
}

export type NativeChatApi = {
  /** Reads the latest limit turns; the hook-reported transcriptPath takes precedence over ID globbing. */
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string
  ) => Promise<NativeChatReadSessionResult>
  /** First frame is a bounded snapshot; later frames contain only appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
  /** A local structured chat's last failed naming output; null when none or not local. */
  getConversationNameFailureOutput: (sessionId: string) => Promise<string | null>
}
