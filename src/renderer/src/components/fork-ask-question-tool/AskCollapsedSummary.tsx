import { translate } from '@/i18n/i18n'
import type { AskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskRegistryResult } from '../../../../shared/fork-ask-question-tool/ask-question-schema'

function statusLabel(status: AskStatus): string {
  switch (status) {
    case 'answered':
      return translate('components.fork-ask-question-tool.askCard.statusAnswered', 'Answered')
    case 'partial':
      return translate('components.fork-ask-question-tool.askCard.statusPartial', 'Partially answered')
    case 'declined':
      return translate('components.fork-ask-question-tool.askCard.statusDeclined', 'Declined')
    case 'timed_out':
      return translate('components.fork-ask-question-tool.askCard.statusTimedOut', 'Timed out')
    case 'unavailable':
      return translate('components.fork-ask-question-tool.askCard.statusUnavailable', 'Unavailable')
    case 'registered':
    case 'pending':
      return ''
  }
}

/** Read-only rendering an ask collapses into after a terminal transition (logic.md § Card surface). */
export function AskCollapsedSummary({
  status,
  result
}: {
  status: AskStatus
  result: AskRegistryResult
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-input bg-card p-4 shadow-xs">
      <p className="text-sm font-medium text-foreground">{statusLabel(status)}</p>
      <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">
        {result.summary}
      </pre>
    </div>
  )
}
