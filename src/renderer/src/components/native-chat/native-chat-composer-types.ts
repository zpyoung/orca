import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type {
  AgentComposerCoreProps,
  AgentComposerHandle
} from '../agent-composer/agent-composer-types'

export type NativeChatComposerProps = AgentComposerCoreProps & {
  /** Record a dispatched slash command that does not create a chat turn. */
  onSlashCommand?: (command: string) => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** Launch context prefilled into the TUI input as an unsent draft; adopted as the composer draft. */
  launchDraft?: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved?: boolean
}

export type NativeChatComposerHandle = AgentComposerHandle
