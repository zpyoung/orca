import type { CaptureStructuredAgentSessionPresentation } from './use-structured-agent-session-mutate'
import type { StructuredAgentSessionSendRequest } from './structured-agent-session-send-slot'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session/agent-session-conversation-command'
import type { StructuredAgentContextUsage } from '../../../../shared/structured-agent-session-context-usage'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionCommandOutcome,
  StructuredAgentSessionCommandRefusalCause
} from '../../../../shared/structured-agent-session-composer'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatSessionOptionObservation } from '../../../../shared/native-chat-types'
import type {
  AgentComposerCoreProps,
  AgentComposerHandle
} from './fork-agent-composer/agent-composer-types'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'
import type { NativeChatAfterStopSend } from './native-chat-composer-target'
import type { NativeChatLocalCommandAnswer } from './use-native-chat-local-command-answer'
import type { NativeChatRecallSource } from './native-chat-sent-prompt-history'

export type NativeChatComposerErrorDetail = {
  /** Error text Orca did not write, shown apart and copyable. */
  errorText?: string
  /** A refused command's cause: its line is said only while that still holds. */
  refusedWhile?: StructuredAgentSessionCommandRefusalCause
}

/** One opening of the picker, asked for by a slash command. */
export type NativeChatOptionPickerRequest = {
  id: string
  /** Drops the request once the picker has seen it, whether or not it could open. */
  consume: () => void
}

export type NativeChatStructuredComposerTransport = {
  capturePresentation: CaptureStructuredAgentSessionPresentation
  conversationCommands?: readonly AgentSessionConversationCommand[]
  send: (
    text: string,
    attachments: readonly AgentComposerImageAttachment[],
    request?: StructuredAgentSessionSendRequest
  ) => boolean | 'queued'
  /** A send is out: Send stays disabled, and a send returns false, until it settles. */
  sendOut?: boolean
  /** Send is held for this reason, which the disabled button says. */
  sendBlockedReason?: string
  dispatchCommand: (text: string) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  /** Use host-reported slash commands, falling back to curated catalogs for older hosts. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  /** Request command refresh; updated choices arrive through sessionCommands. */
  refreshCommands?: () => void
  setCommandsMenuOpen?: (open: boolean) => void
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
  /** The host has not confirmed this chat: session uploads wait for publication. */
  sessionPending?: boolean
  sessionPendingNotice?: string
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
  /** Input-only edit session: every submit saves, Escape cancels, and send-only actions are absent. */
  editSession?: { save: () => void; cancel: () => void; canSave: boolean }
  /** Unsent-draft owner; defaults to paneKey, while structured chats share conversation scope. */
  draftScopeKey?: string
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** While Stopping, queue a card or send for the host to hold until settlement. */
  afterStop?: NativeChatAfterStopSend
  /** Settle an optimistic echo whose write was refused or never acknowledged. */
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  /** A prompt card owns the input region; the composer stays mounted but hidden. */
  inputOwnedByCard?: boolean
  /** Record non-turn commands; output holds the host’s response when the agent never saw it. */
  onSlashCommand?: (command: string, output?: string) => void
  /** The host's own answer to a command the agent must not see, or null to send it. */
  answerCommandLocally?: NativeChatLocalCommandAnswer
  /** Anything sent to the terminal: a message, a command or a session option. */
  onSubmitted?: () => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** The tab's launch seed as this pane sees it. */
  launchSeed?: NativeChatLaunchSeed
  /** Model and effort the agent recorded for itself in its session log; pre-fills
   *  the option pickers without waiting on the startup frame still being on screen. */
  reportedSessionOptions?: NativeChatSessionOptionObservation | null
  /** Structured journal transport; absent keeps the existing PTY path unchanged. */
  structuredTransport?: NativeChatStructuredComposerTransport
  /** Empty-composer Cmd/Ctrl+Enter steers the newest queued draft; false falls through to ordinary send. */
  steerQueued?: () => boolean
  /** The chat's own notices, shown in the composer's notice card above its input. */
  notices?: readonly NativeChatComposerNotice[]
  /** The conversation Up/Down recalls prompts from. */
  recallSource?: NativeChatRecallSource
}

/** The unsent TUI launch prefill and this pane’s adoption/cleanup authority. */
export type NativeChatLaunchSeed = {
  launchDraft: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved: boolean
  /** False for every pane of a split tab; gates adopting the seed, not cleanup. */
  ownsTabWideLaunchDraft: boolean
}

export type NativeChatComposerHandle = AgentComposerHandle & {
  isComposing?: () => boolean
  insertPastedText?: (text: string) => boolean
  /** Whether the input is there and enabled, so text given to it lands. */
  acceptsText: () => boolean
  /** Append deduplicated text after a blank line and place the caret at its end. */
  appendText: (text: string) => void
  /** Whether a node is inside the composer's own input, not merely the chat pane. */
  contains: (node: Node | null) => boolean
}
