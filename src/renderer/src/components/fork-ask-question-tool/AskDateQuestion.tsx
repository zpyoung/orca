import { cn } from '@/lib/utils'
import type { AskDateQuestion as AskDateQuestionSpec } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from './ask-question-draft'

export function AskDateQuestion({
  question,
  draft,
  onChange,
  disabled,
  invalid
}: {
  question: AskDateQuestionSpec
  draft: AskQuestionDraft
  onChange: (next: AskQuestionDraft) => void
  disabled: boolean
  invalid: boolean
}): React.JSX.Element {
  return (
    <input
      type="date"
      value={draft.text}
      disabled={disabled}
      aria-invalid={invalid}
      aria-label={question.header ?? question.question}
      onChange={(event) => onChange({ ...draft, text: event.target.value })}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-xs outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'
      )}
    />
  )
}
