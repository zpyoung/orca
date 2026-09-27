import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AskTextQuestion as AskTextQuestionSpec } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from './ask-question-draft'

export function AskTextQuestion({
  question,
  draft,
  onChange,
  disabled,
  invalid
}: {
  question: AskTextQuestionSpec
  draft: AskQuestionDraft
  onChange: (next: AskQuestionDraft) => void
  disabled: boolean
  invalid: boolean
}): React.JSX.Element {
  const value = draft.text
  const label = question.header ?? question.question
  const handleChange = (nextValue: string): void => onChange({ ...draft, text: nextValue })

  return question.multiline ? (
    <Textarea
      value={value}
      disabled={disabled}
      aria-invalid={invalid}
      aria-label={label}
      onChange={(event) => handleChange(event.target.value)}
    />
  ) : (
    <Input
      type="text"
      value={value}
      disabled={disabled}
      aria-invalid={invalid}
      aria-label={label}
      onChange={(event) => handleChange(event.target.value)}
    />
  )
}
