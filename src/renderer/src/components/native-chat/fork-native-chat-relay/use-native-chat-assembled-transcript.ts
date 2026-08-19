import { useMemo, useRef } from 'react'
import type { AgentType, NativeChatMessage } from '../../../../../shared/native-chat-types'
import {
  assembleCachedTranscript,
  createNativeChatTranscriptCache
} from './native-chat-incremental-assembler'
import { getVerifiedNativeChatCommands } from '../../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../../shared/native-chat-command-envelope'

/**
 * The rendered transcript for a pane: the paged base list plus live appends,
 * run through the incremental assembler.
 *
 * Suffix-extensions take the fast append path; anything else resets, so the
 * cache can never drift from what a full rebuild would produce (#17).
 */
export function useNativeChatAssembledTranscript(
  baseMessages: readonly NativeChatMessage[],
  appended: readonly NativeChatMessage[],
  sessionId: string | null,
  agent: AgentType
): NativeChatMessage[] {
  const cacheRef = useRef(createNativeChatTranscriptCache())

  const assembledMessages = useMemo(
    () =>
      // Base-axis signature: any change forces a full reset so a missed trigger can't leave the cache stale.
      assembleCachedTranscript(
        cacheRef.current,
        baseMessages,
        appended,
        `${agent}\u0000${sessionId ?? ''}`
      ),
    [baseMessages, appended, sessionId, agent]
  )

  // Why: skill invocations are user turns but Claude records them as noise-filtered command envelopes, so surface them as the literal token here.
  return useMemo(
    () =>
      surfaceSkillInvocationUserTurns(
        assembledMessages,
        new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
      ),
    [assembledMessages, agent]
  )
}
