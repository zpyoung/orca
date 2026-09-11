import type { AgentType } from '../../../../../shared/agent-status-types'
import type { ComposerSendTier } from './composer-send-tier'
import type { SendOutcome } from './native-chat-send-outcome'

export type AgentComposerCoreProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop input while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** Host sends through its own transport rather than a PTY, so a null targetPtyId
   *  must not disable the composer. */
  allowWithoutTarget?: boolean
  /** Disables submission without disabling draft editing or attachments. */
  sendDisabled?: boolean
  /** Host-specific fixed-height layout; omitted by native chat. */
  layout?: 'dock'
  /** True while the hosted TUI reports an in-flight turn; shows the separate Stop action. */
  isWorking?: boolean
  /** Dock send coverage; omitted by native chat so its launch-draft path stays unchanged. */
  sendTier?: ComposerSendTier
  /** Observability hook for the dock's best-effort post-send result. */
  onSendOutcome?: (outcome: SendOutcome) => void
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
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
