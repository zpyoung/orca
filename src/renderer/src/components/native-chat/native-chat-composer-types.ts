import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatSessionOptionObservation } from '../../../../shared/native-chat-types'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { StructuredAgentContextUsage } from '../../../../shared/structured-agent-session-context-usage'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session-wire'
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

/** A queue the host holds, with cards waiting. */
export type NativeChatQueueHold = {
  /** Every card shown, held or not. */
  count: number
  /** Delete every card; false when one could not be (already reported). */
  clear: () => Promise<boolean>
}

export type NativeChatStructuredComposerTransport = {
  conversationCommands?: readonly AgentSessionConversationCommand[]
  send: (text: string, attachments: readonly AgentComposerImageAttachment[]) => boolean
  dispatchCommand: (text: string) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  /** The `/` surface the running session reports. Absent keeps the curated
   *  per-agent catalog, which is what an older host leaves the client with. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  /** False when the agent takes no image input, as its host registered it. */
  acceptsImages?: boolean
  /** The session's context usage; null until the journal can state it. */
  contextUsage?: StructuredAgentContextUsage | null
  worktreeId?: string
  /** Present only where the host can set this session's goal. */
  threadGoal?: { setObjective: (objective: string) => Promise<boolean> }
  onError: (message: string | null, detail?: NativeChatComposerErrorDetail) => void
  /** A local send: brings the latest into view at the press, not when the host answers. */
  onSubmitted?: () => void
  runtime: 'local' | 'remote'
  /** The session behind this composer; a real user send relinquishes orchestration ownership. */
  sessionId: string
  /** Owning runtime for that report; null is the local runtime. */
  runtimeEnvironmentId: string | null
  /** Present while the queue is held: a message sent now first asks whether to clear its cards. */
  queueHold?: NativeChatQueueHold
  /** Present while the host holds the queue and no turn runs: an empty composer's primary
   *  action becomes Resume, which releases it. */
  queueResume?: NativeChatQueueResume
}

export type NativeChatOptimisticSendOutcome = {
  /** The host refused the write: mark the echo "Message not sent". */
  reject: (pendingId: string) => void
  /** The write acknowledgment was lost: hold the echo, then flag it unconfirmed. */
  holdUnconfirmed: (pendingId: string) => void
}

export type NativeChatComposerProps = AgentComposerCoreProps & {
  /** Prompts recovered by a host from the pane transcript or live status. */
  historyPrompts?: readonly string[]
  /** Settle an optimistic echo whose write was refused or never acknowledged. */
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  /** Record a dispatched slash command that does not create a chat turn. */
  onSlashCommand?: (command: string) => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** The tab's launch seed as this pane sees it. */
  launchSeed?: NativeChatLaunchSeed
  /** Model and effort the agent recorded for itself in its session log; pre-fills
   *  the option pickers without waiting on the startup frame still being on screen. */
  reportedSessionOptions?: NativeChatSessionOptionObservation | null
  /** Structured journal transport; absent keeps the existing PTY path unchanged. */
  structuredTransport?: NativeChatStructuredComposerTransport
  /** Cmd/Ctrl+Enter from an empty composer: send the newest queued draft now.
   *  False = nothing queued, and the chord falls through to a plain send. */
  steerQueued?: () => boolean
  /** The chat's own notices, shown in the composer's notice card above its input. */
  notices?: readonly NativeChatComposerNotice[]
  /** The conversation Up/Down recalls prompts from. */
  recallSource?: NativeChatRecallSource
}

/** Launch context prefilled into the TUI input as an unsent draft, plus the two
 *  facts that decide its fate in this pane's composer. */
export type NativeChatLaunchSeed = {
  launchDraft: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved: boolean
  /** False for every pane of a split tab; gates adopting the seed, not cleanup. */
  ownsTabWideLaunchDraft: boolean
}

export type NativeChatComposerHandle = AgentComposerHandle & {
  /** Whether a node is inside the composer's own input, not merely the chat pane.
   *  Absent on a dock composer, whose field handles its own paste. */
  contains?: (node: Node | null) => boolean
}
