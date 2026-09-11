import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectHeadAsk } from '@/store/slices/fork-ask-question-tool/asks'
import { resolvePaneKeyWorktreeIdFromTabs } from '@/store/slices/ui/ui-slice-agent-notification-acknowledgement'
import { isTerminalAskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { useAskNotificationEscalation } from './ask-notification-escalation'

function AskPaneEscalation({ paneKey }: { paneKey: string }): null {
  const head = useAppStore((state) => selectHeadAsk(state, paneKey))
  const worktreeId = useAppStore((state) => resolvePaneKeyWorktreeIdFromTabs(state, paneKey))
  const isAwaitingAnswer = head !== null && !isTerminalAskStatus(head.status)

  useAskNotificationEscalation({
    // A null askId disarms; passing it is how a resolved ask, or a pane whose tab has gone,
    // cancels its own timer.
    askId: isAwaitingAnswer && worktreeId !== null ? head.askId : null,
    status: head?.status ?? null,
    worktreeId: worktreeId ?? '',
    paneKey
  })
  return null
}

/**
 * Escalates every unanswered ask to an OS notification once its pane has gone unattended, not
 * just the one on screen. The Questions panel follows the focused session, so a question waiting
 * on a background pane has no on-screen trace at all — this is what makes it reachable.
 *
 * One child per pane because the escalation hook owns a single timer; keying on pane keys alone
 * means an answer on one pane does not re-subscribe the others.
 */
export function AskEscalationGate(): React.JSX.Element {
  const paneKeys = useAppStore(
    useShallow((state) => Object.keys(state.pendingAsksByPaneKey).sort())
  )

  return (
    <>
      {paneKeys.map((paneKey) => (
        <AskPaneEscalation key={paneKey} paneKey={paneKey} />
      ))}
    </>
  )
}
