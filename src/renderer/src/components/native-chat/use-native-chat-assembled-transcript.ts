import { useMemo, useRef } from 'react'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  applyAppends,
  createIncrementalAssembler,
  reset as resetAssembler,
  sharesNativeChatPrefix
} from './native-chat-incremental-assembler'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../shared/native-chat-command-envelope'

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
  const assemblerRef = useRef(createIncrementalAssembler())
  const appliedTranscriptRef = useRef<readonly NativeChatMessage[]>([])
  const baseSigRef = useRef<string | null>(null)
  const baseMessagesRef = useRef<readonly NativeChatMessage[]>(baseMessages)

  const assembledMessages = useMemo(() => {
    const transcript =
      appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
    // Base-axis signature: any change forces a full reset so a missed trigger can't leave the cache stale.
    const baseSig = `${agent}\u0000${sessionId ?? ''}`
    const baseChanged = baseSig !== baseSigRef.current || baseMessages !== baseMessagesRef.current
    const applied = appliedTranscriptRef.current
    const isSuffixExtension =
      !baseChanged &&
      transcript.length >= applied.length &&
      sharesNativeChatPrefix(transcript, applied, applied.length)

    let out: NativeChatMessage[]
    if (isSuffixExtension && transcript.length > applied.length) {
      out = applyAppends(assemblerRef.current, transcript.slice(applied.length))
    } else if (isSuffixExtension) {
      out = assemblerRef.current.messages
    } else {
      out = resetAssembler(assemblerRef.current, transcript)
    }
    baseSigRef.current = baseSig
    baseMessagesRef.current = baseMessages
    appliedTranscriptRef.current = transcript
    return out
    // baseMessages/appended are the only message-set inputs; sessionId/agent gate the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseMessages, appended, sessionId, agent])

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
