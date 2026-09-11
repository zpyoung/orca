import { translate } from '@/i18n/i18n'
import type { AskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskRegistryResult } from '../../../../shared/fork-ask-question-tool/ask-question-schema'

function statusLabel(status: AskStatus): string {
  switch (status) {
    case 'answered':
      return translate('components.fork-ask-question-tool.askCard.statusAnswered', 'Answered')
    case 'partial':
      return translate(
        'components.fork-ask-question-tool.askCard.statusPartial',
        'Partially answered'
      )
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <p className="shrink-0 px-4 pt-4 text-sm font-medium text-foreground">
        {statusLabel(status)}
      </p>
      <pre className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-4 pb-4 pt-1 font-sans text-xs text-muted-foreground">
        {result.summary}
      </pre>
    </div>
  )
}
