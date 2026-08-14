import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isTextBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'

function messagePrompt(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
}

/** Merges transcript and live status chronologically, keeping the newest copy of a prompt. */
export function terminalDockHistoryPrompts(
  messages: readonly NativeChatMessage[],
  status: AgentStatusEntry | undefined
): readonly string[] {
  const candidates = [
    ...messages
      .filter((message) => message.role === 'user')
      .map((message, order) => ({ prompt: messagePrompt(message), at: message.timestamp, order })),
    ...(status?.stateHistory.map((entry, order) => ({
      prompt: entry.prompt,
      at: entry.startedAt,
      order: messages.length + order
    })) ?? []),
    {
      prompt: status?.prompt ?? '',
      at: status?.stateStartedAt ?? null,
      order: messages.length + (status?.stateHistory.length ?? 0)
    }
  ]
  const newestByPrompt = new Map<string, (typeof candidates)[number]>()
  for (const candidate of candidates) {
    if (candidate.prompt.trim() !== '') {
      newestByPrompt.set(candidate.prompt, candidate)
    }
  }
  return [...newestByPrompt.values()]
    .sort((left, right) => {
      if (left.at === null || right.at === null) {
        return left.at === right.at ? left.order - right.order : left.at === null ? -1 : 1
      }
      return left.at - right.at || left.order - right.order
    })
    .map(({ prompt }) => prompt)
}
