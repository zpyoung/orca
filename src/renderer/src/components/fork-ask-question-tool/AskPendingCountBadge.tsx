import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { selectPendingAskCount } from '../../store/slices/fork-ask-question-tool/asks'

function pendingAskCountLabel(count: number): string {
  return translate(
    'components.fork-ask-question-tool.badge.pendingCountLabel',
    '{{count}} pending questions',
    { count, defaultValue_one: '{{count}} pending question' }
  )
}

/** Counts asks awaiting an answer across every pane. */
export function AskPendingCountBadge(): React.JSX.Element | null {
  const count = useAppStore(selectPendingAskCount)
  if (count === 0) {
    return null
  }
  return (
    <Badge
      variant="secondary"
      className="text-agent-question"
      aria-label={pendingAskCountLabel(count)}
    >
      {count}
    </Badge>
  )
}
