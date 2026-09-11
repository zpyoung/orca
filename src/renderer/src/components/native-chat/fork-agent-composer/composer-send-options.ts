import { buildAgentTuiClearInputForText } from '../../../../../shared/agent-tui-input-clear'
import type { NativeChatSendOptions } from '../native-chat-runtime-send'
import { agentInputLineCleared } from '../native-chat-launch-draft-send'
import type { SendOutcome } from './native-chat-send-outcome'
import type { ComposerSendTier } from './composer-send-tier'

export function buildComposerSendOptions(args: {
  text: string
  tier: ComposerSendTier
  readTerminalScreen?: () => string | null
  onOutcome: (outcome: SendOutcome) => void
}): NativeChatSendOptions {
  const observeInputLine = (): boolean => agentInputLineCleared(args.readTerminalScreen?.() ?? null)
  return {
    clearInput: buildAgentTuiClearInputForText(args.text),
    ...(args.tier === 'verified'
      ? { confirmCleared: observeInputLine, confirmSubmitted: observeInputLine }
      : {}),
    onOutcome: args.onOutcome
  }
}
