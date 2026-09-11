// Resolves the one per-line decoder the transcript readers run alongside the
// message decoder. It folds the two independent companion values — turn
// lifecycle and session options — into a single call so a reader threads one
// decode/collect pair rather than one per value.

import type { AgentType } from '../../../shared/native-chat-types'
import type { NativeChatTranscriptCompanion } from '../../../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import { nativeChatSessionOptionDecoderForAgent } from './transcript-session-options'
import { nativeChatTurnLifecycleDecoderForAgent } from '../transcript-turn-lifecycle'

export type NativeChatTranscriptCompanionDecoder = (
  line: string,
  fallbackId: string
) => NativeChatTranscriptCompanion | null

/** Null when this agent has neither decoder, so a reader can skip the work. */
export function nativeChatTranscriptCompanionDecoderForAgent(
  agent: AgentType
): NativeChatTranscriptCompanionDecoder | null {
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(agent)
  const decodeSessionOptions = nativeChatSessionOptionDecoderForAgent(agent)
  if (!decodeLifecycle && !decodeSessionOptions) {
    return null
  }
  return (line, fallbackId) => {
    const lifecycle = decodeLifecycle?.(line, fallbackId)
    const sessionOptions = decodeSessionOptions?.(line)
    if (!lifecycle && !sessionOptions) {
      return null
    }
    return {
      ...(lifecycle ? { lifecycle } : {}),
      ...(sessionOptions ? { sessionOptions } : {})
    }
  }
}
