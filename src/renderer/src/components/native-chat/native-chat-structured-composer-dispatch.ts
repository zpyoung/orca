import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly AgentComposerImageAttachment[] = []
): Promise<{ accepted: boolean; error: string | null }> {
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  const admission = transport.send(text, attachments)
  return { accepted: admission !== false, error: null, revealsTranscript: admission === true }
}
