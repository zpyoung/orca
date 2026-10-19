import type { AgentType } from '../../../../../shared/agent-status-types'
import type { ComposerSendTier } from './composer-send-tier'
import type { SendOutcome } from './native-chat-send-outcome'
import type { NativeChatComposerNotice } from '../native-chat-composer-notice'
import type { NativeChatAfterStopSend } from '../native-chat-composer-target'
import type { NativeChatOptimisticSendOutcome } from '../native-chat-composer-types'

export type AgentComposerCoreProps = {
  /** Tab hosting the agent; used to resolve the live ptyId. */
  terminalTabId: string
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Owner of the unsent draft; defaults to `paneKey`. A structured chat's is its conversation,
   *  shared by every composer showing it. */
  draftScopeKey?: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop input while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** The chat can't take input yet (a program it needs isn't installed): the composer is disabled
   *  and this is its placeholder. */
  unavailableHint?: string | undefined
  /** Host sends through its own transport rather than a PTY, so a null targetPtyId
   *  must not disable the composer. */
  allowWithoutTarget?: boolean
  /** Disables submission without disabling draft editing or attachments. */
  sendDisabled?: boolean
  /** Host-specific fixed-height layout; omitted by native chat. */
  layout?: 'dock'
  /** True while the hosted TUI reports an in-flight turn; shows the separate Stop action. */
  isWorking?: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** The chat reads Stopping: the placeholder says a message runs after the stop, queued as a
   *  card where the host holds sends as cards (`queue`), else sent and held by the host (`send`). */
  afterStop?: NativeChatAfterStopSend
  /** A prompt card owns the input region; the composer stays mounted but hidden. */
  inputOwnedByCard?: boolean
  /** The host's own notices, shown in the composer's notice card above its input. */
  notices?: readonly NativeChatComposerNotice[]
  /** Dock send coverage; omitted by native chat so its launch-draft path stays unchanged. */
  sendTier?: ComposerSendTier
  /** Observability hook for the dock's best-effort post-send result. */
  onSendOutcome?: (outcome: SendOutcome) => void
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Settle an optimistic echo whose write was refused or never acknowledged. */
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** Reads the hosted TUI's current rendered screen when chat is entered. */
  readTerminalScreen?: () => string | null
}

export type AgentComposerHandle = {
  focus: () => boolean
  insertTypedText: (text: string) => boolean
  /** Routes pane-level paste events back to the composer field. */
  handlePasteEvent: (event: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
    defaultPrevented: boolean
  }) => void
  /** Pastes clipboard content when no DOM paste event is available. */
  pasteFromClipboard: () => void
}
