import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { resolvePaneKeyWorktreeIdFromTabs } from '@/store/slices/ui/ui-slice-agent-notification-acknowledgement'
import {
  isTerminalAskStatus,
  type AskStatus
} from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { useAskNotificationEscalation } from './ask-notification-escalation'

type PendingAskEscalation = {
  askId: string
  status: AskStatus
  worktreeId: string
  paneKey: string
}

function AskEscalationWatcher({ askId, status, worktreeId, paneKey }: PendingAskEscalation): null {
  useAskNotificationEscalation({ askId, status, worktreeId, paneKey })
  return null
}

/**
 * Escalates every unanswered ask to an OS notification once its pane has gone unattended, not
 * just the one on screen. The Questions panel follows the focused session, so a question waiting
 * on a background pane has no on-screen trace at all — this is what makes it reachable.
 *
 * One watcher per ask because the escalation hook tracks a single timer; mounting them as
 * children keeps that one-ask contract while the set of asks varies.
 */
export function AskEscalationGate(): React.JSX.Element {
  const pendingAsksByPaneKey = useAppStore((state) => state.pendingAsksByPaneKey)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)

  const escalations = useMemo<PendingAskEscalation[]>(() => {
    const state = useAppStore.getState()
    const rows: PendingAskEscalation[] = []
    for (const [paneKey, bucket] of Object.entries(pendingAsksByPaneKey)) {
      const head = bucket[0]
      if (!head || isTerminalAskStatus(head.status)) {
        continue
      }
      const worktreeId = resolvePaneKeyWorktreeIdFromTabs(state, paneKey)
      if (worktreeId === null) {
        continue
      }
      rows.push({ askId: head.askId, status: head.status, worktreeId, paneKey })
    }
    return rows
  }, [pendingAsksByPaneKey, tabsByWorktree])

  return (
    <>
      {escalations.map((escalation) => (
        <AskEscalationWatcher key={escalation.askId} {...escalation} />
      ))}
    </>
  )
}
