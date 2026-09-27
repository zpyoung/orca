import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AskConfirmQuestion as AskConfirmQuestionSpec } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from './ask-question-draft'

export function AskConfirmQuestion({
  question,
  draft,
  onChange,
  disabled
}: {
  question: AskConfirmQuestionSpec
  draft: AskQuestionDraft
  onChange: (next: AskQuestionDraft) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <div className="flex gap-2" role="group" aria-label={question.header ?? question.question}>
      <ConfirmOption
        label={translate('components.fork-ask-question-tool.askCard.yes', 'Yes')}
        selected={draft.confirm === true}
        disabled={disabled}
        onSelect={() => onChange({ ...draft, confirm: true })}
      />
      <ConfirmOption
        label={translate('components.fork-ask-question-tool.askCard.no', 'No')}
        selected={draft.confirm === false}
        disabled={disabled}
        onSelect={() => onChange({ ...draft, confirm: false })}
      />
    </div>
  )
}

function ConfirmOption({
  label,
  selected,
  disabled,
  onSelect
}: {
  label: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input text-foreground hover:bg-accent'
      )}
    >
      {label}
    </button>
  )
}
