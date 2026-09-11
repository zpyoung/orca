import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import type { NativeChatTranscriptCompanion } from '../../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import type { ResolveSessionFileOptions } from './session-file-resolver'
import type { NativeChatTranscriptCompanionDecoder } from './fork-native-chat-session-options/transcript-companion-decoder'

export type NativeChatTranscriptTailReader = (args: {
  filePath: string
  limit: number
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
  includeTrailingLine?: boolean
  endOffset?: number
  decodeCompanion?: NativeChatTranscriptCompanionDecoder | null
  maxBytes?: number
  signal?: AbortSignal
}) => Promise<{
  messages: NativeChatMessage[]
  companion?: NativeChatTranscriptCompanion
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
}>

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  onAppend: (messages: NativeChatMessage[], companion?: NativeChatTranscriptCompanion) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    /** Set when the initial drain could not deliver a transcript. */
    error?: string,
    companion?: NativeChatTranscriptCompanion
  ) => void
  /** The transcript file does not exist yet (a session whose agent has not
   *  flushed, or has not been prompted at all). Fires at most once, before any
   *  snapshot, so a client can settle its view on the empty window it really
   *  has instead of spinning — while still knowing the read is not settled. */
  onTranscriptPending?: () => void
  onReplace?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    companion?: NativeChatTranscriptCompanion
  ) => void
  initialLimit?: number
  tailReader?: NativeChatTranscriptTailReader
  /** Byte ceiling for snapshot and replacement reads. Set by the relay, whose
   *  frames have to fit a shared writer budget; a dropped older turn still
   *  shows up as `hasMore` with a `beforeOffset` that can page back to it. */
  initialMaxBytes?: number
  filePath?: string
  debounceMs?: number
  /** Test-only override for the production resolve-poll backoff. */
  resolvePollIntervalMs?: number
  /** Test-only override for the host-side watcher reconciliation interval. */
  reconciliationIntervalMs?: number
}

export type NativeChatTranscriptSubscription = {
  unsubscribe: () => void
  watching: boolean
}
