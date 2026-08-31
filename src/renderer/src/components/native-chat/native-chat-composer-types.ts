import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatSessionOptionObservation } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type {
  AgentComposerCoreProps,
  AgentComposerHandle
} from './fork-agent-composer/agent-composer-types'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'

export type NativeChatOptionPickerRequest = {
  id: string
  sequence: number
}

export type NativeChatStructuredComposerTransport = {
  send: (text: string, attachments: readonly AgentComposerImageAttachment[]) => boolean
  dispatchCommand: (text: string) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  worktreeId?: string
  onError: (message: string | null) => void
  runtime: 'local' | 'remote'
}

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
  /** Structured journal transport; absent keeps the existing PTY path unchanged. */
  structuredTransport?: NativeChatStructuredComposerTransport
}

export type NativeChatComposerHandle = AgentComposerHandle
