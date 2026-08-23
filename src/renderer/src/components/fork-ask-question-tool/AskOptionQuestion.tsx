import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type {
  AskMultiselectQuestion,
  AskSelectQuestion
} from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from './ask-question-draft'
import { AskPreviewFrame } from './AskPreviewFrame'

export function AskOptionQuestion({
  question,
  draft,
  onChange,
  disabled
}: {
  question: AskSelectQuestion | AskMultiselectQuestion
  draft: AskQuestionDraft
  onChange: (next: AskQuestionDraft) => void
  disabled: boolean
}): React.JSX.Element {
  const toggle = (value: string): void => {
    if (question.type === 'select') {
      onChange({ ...draft, selected: draft.selected.includes(value) ? [] : [value] })
      return
    }
    const selected = draft.selected.includes(value)
      ? draft.selected.filter((v) => v !== value)
      : [...draft.selected, value]
    onChange({ ...draft, selected })
  }

  return (
    <div
      role="group"
      aria-label={question.header ?? question.question}
      className="divide-y divide-border/60 overflow-hidden rounded-md border border-border"
    >
      {question.options.map((option) => (
        <AskOptionRow
          key={option.value}
          label={option.label}
          description={option.description}
          preview={option.preview}
          selected={draft.selected.includes(option.value)}
          disabled={disabled}
          onSelect={() => toggle(option.value)}
        />
      ))}
      <div className="p-2">
        <Input
          value={draft.freeText}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, freeText: event.target.value })}
          placeholder={translate(
            'components.fork-ask-question-tool.askCard.otherPlaceholder',
            'Add your own answer'
          )}
        />
      </div>
    </div>
  )
}

function AskOptionRow({
  label,
  description,
  preview,
  selected,
  disabled,
  onSelect
}: {
  label: string
  description?: string
  preview?: { format: 'markdown' | 'html'; content: string }
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false)

  return (
    <div className={cn(selected ? 'bg-accent' : undefined)}>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors disabled:pointer-events-none hover:bg-accent"
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full border border-input',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'text-transparent'
          )}
        >
          <Check className="size-3" strokeWidth={3} />
        </span>
        <span className="min-w-0">
          <span className="block break-words text-sm text-foreground">{label}</span>
          {description ? (
            <span className="block break-words text-xs text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </button>
      {preview ? (
        <Collapsible open={previewOpen} onOpenChange={setPreviewOpen} className="px-3 pb-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              {previewOpen
                ? translate('components.fork-ask-question-tool.askPreview.hide', 'Hide preview')
                : translate('components.fork-ask-question-tool.askPreview.show', 'Show preview')}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <AskPreviewFrame preview={preview} className="mt-2 h-40 w-full rounded-md border border-border" />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}
