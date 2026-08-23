import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatSessionOptionObservation } from '../../../../shared/native-chat-types'
import type {
  AgentComposerCoreProps,
  AgentComposerHandle
} from './fork-agent-composer/agent-composer-types'

export type NativeChatComposerProps = AgentComposerCoreProps & {
  /** Prompts recovered by a host from the pane transcript or live status. */
  historyPrompts?: readonly string[]
  /** Record a dispatched slash command that does not create a chat turn. */
  onSlashCommand?: (command: string) => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** Launch context prefilled into the TUI input as an unsent draft; adopted as the composer draft. */
  launchDraft?: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved?: boolean
  /** Model and effort the agent recorded for itself in its session log; pre-fills
   *  the option pickers without waiting on the startup frame still being on screen. */
  reportedSessionOptions?: NativeChatSessionOptionObservation | null
}

export type NativeChatComposerHandle = AgentComposerHandle
