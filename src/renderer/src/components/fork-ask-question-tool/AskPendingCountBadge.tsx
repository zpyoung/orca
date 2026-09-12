import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { selectPendingAskCount } from '../../store/slices/fork-ask-question-tool/asks'

function pendingAskCountLabel(count: number): string {
  return count === 1
    ? translate(
        'components.fork-ask-question-tool.badge.pendingCountLabel_one',
        '{{count}} pending question',
        { count }
      )
    : translate(
        'components.fork-ask-question-tool.badge.pendingCountLabel_other',
        '{{count}} pending questions',
        { count }
      )
}

/** Sidebar-wide count of asks still awaiting an answer, across every pane (tech.md § C8). */
export function AskPendingCountBadge(): React.JSX.Element | null {
  const count = useAppStore(selectPendingAskCount)
  if (count === 0) {
    return null
  }
  return (
    <Badge variant="secondary" className="text-agent-question" aria-label={pendingAskCountLabel(count)}>
      {count}
    </Badge>
  )
}
