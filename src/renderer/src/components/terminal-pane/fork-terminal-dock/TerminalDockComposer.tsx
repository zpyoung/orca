import { useMemo, useState, type RefObject } from 'react'
import { useAppStore } from '../../../store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { isNativeChatSupportedAgent } from '../../../../../shared/native-chat-agent-support'
import type { ComposerSendTier } from '../../native-chat/fork-agent-composer/composer-send-tier'
import type { SendOutcome } from '../../native-chat/fork-agent-composer/native-chat-send-outcome'
import type { AgentComposerHandle } from '../../native-chat/fork-agent-composer/agent-composer-types'
import { NativeChatComposer } from '../../native-chat/NativeChatComposer'
import { NativeChatInteractiveCard } from '../../native-chat/NativeChatInteractiveCard'
import { selectNativeChatRuntimeEnvironmentId } from '../../native-chat/native-chat-runtime-owner'
import {
  useNativeChatInteractiveSend,
  type NativeChatInteractiveSend
} from '../../native-chat/use-native-chat-interactive-send'
import { useNativeChatRetainedSession } from '../../native-chat/use-native-chat-retained-session'
import { terminalDockHistoryPrompts } from './terminal-dock-history'

export type TerminalDockComposerProps = {
  ref: React.Ref<AgentComposerHandle>
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  agent: AgentType
  canSend: boolean
  sendTier: ComposerSendTier
  readTerminalScreen?: () => string | null
  /** The question card's free-text row. The dock keeps its composer mounted
   *  beside an active card, so pane-level Paste needs this to tell the two
   *  apart by focus. */
  answerInputRef?: RefObject<HTMLInputElement | null>
  onSendOutcome?: (outcome: SendOutcome) => void
}

export function TerminalDockComposer({
  answerInputRef,
  ...props
}: TerminalDockComposerProps): React.JSX.Element {
  const status = useAppStore((state) => state.agentStatusByPaneKey[props.paneKey])
  const isWorking = status?.state === 'working'
  const interactiveSend = useNativeChatInteractiveSend(
    props.terminalTabId,
    props.paneKey,
    props.targetPtyId,
    props.agent
  )
  if (isNativeChatSupportedAgent(props.agent)) {
    return (
      <TerminalDockCardComposer
        {...props}
        answerInputRef={answerInputRef}
        isWorking={isWorking}
        interactiveSend={interactiveSend}
      />
    )
  }
  return (
    <NativeChatComposer
      {...props}
      layout="dock"
      isWorking={isWorking}
      onStop={interactiveSend.cancel}
    />
  )
}

function TerminalDockCardComposer({
  answerInputRef,
  ...props
}: TerminalDockComposerProps & {
  isWorking: boolean
  interactiveSend: NativeChatInteractiveSend
}): React.JSX.Element {
  const status = useAppStore((state) => state.agentStatusByPaneKey[props.paneKey])
  const runtimeEnvironmentId = useAppStore((state) =>
    selectNativeChatRuntimeEnvironmentId(state, props.terminalTabId)
  )
  const session = useNativeChatRetainedSession({
    paneKey: props.paneKey,
    agent: props.agent,
    sessionId: status?.providerSession?.id ?? null,
    transcriptPath: status?.providerSession?.transcriptPath ?? null,
    runtimeEnvironmentId
  })
  const { interactiveSend } = props
  const historyPrompts = useMemo(
    () => terminalDockHistoryPrompts(session.messages, status),
    [session.messages, status]
  )
  const [cardActive, setCardActive] = useState(false)

  return (
    <>
      <div className="absolute inset-x-0 bottom-full z-30" data-terminal-dock-card-overlay="">
        <NativeChatInteractiveCard
          paneKey={props.paneKey}
          send={interactiveSend}
          canSend={props.canSend}
          messages={session.messages}
          transcriptSettled={session.readPhase === 'ready'}
          onShowingCardChange={setCardActive}
          answerInputRef={answerInputRef}
        />
      </div>
      <NativeChatComposer
        {...props}
        layout="dock"
        canSend={props.canSend}
        sendDisabled={cardActive}
        isWorking={props.isWorking}
        onStop={interactiveSend.cancel}
        historyPrompts={historyPrompts}
        reportedSessionOptions={session.sessionOptions}
      />
    </>
  )
}
