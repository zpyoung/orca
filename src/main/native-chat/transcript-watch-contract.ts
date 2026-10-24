export const DESKTOP_READ_WINDOW = 300
export const UNFLUSHED_SETTLE_MS = 1_500

import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import type { NativeChatTranscriptCompanion } from '../../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import type { ResolveSessionFileOptions } from './session-file-resolver'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  onAppend: (messages: NativeChatMessage[], companion?: NativeChatTranscriptCompanion) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    error?: string,
    companion?: NativeChatTranscriptCompanion
  ) => void
  /** Report unflushed history once before snapshots so views can leave loading without claiming a settled read. */
  onTranscriptPending?: () => void
  onReplace?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    companion?: NativeChatTranscriptCompanion
  ) => void
  initialLimit?: number
  filePath?: string
  debounceMs?: number
  resolvePollIntervalMs?: number
  reconciliationIntervalMs?: number
}

export type NativeChatTranscriptSubscription = {
  unsubscribe: () => void
  watching: boolean
}
