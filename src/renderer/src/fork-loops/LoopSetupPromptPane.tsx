import { useRef } from 'react'
import { Pencil } from 'lucide-react'
import { AutomationEditorPromptEditor } from '@/components/automations/AutomationEditorPromptEditor'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ImeTextarea } from '@/lib/ime-text-field'
import { CheckboxField, LoopSetupQueueItems, type SectionProps } from './LoopSetupAdvancedFields'

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </div>
  )
}

function LoopNameTitle({
  value,
  placeholder,
  onChange
}: {
  value: string
  placeholder: string
  onChange: (name: string) => void
}): React.JSX.Element {
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const editNameLabel = translate('fork.loops.setup.editName', 'Edit name')
  return (
    <div className="group/title mb-5 flex max-w-full items-start gap-1">
      <ImeTextarea
        ref={titleRef}
        value={value}
        rows={1}
        placeholder={placeholder}
        aria-label={translate('fork.loops.setup.name', 'Name')}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
          }
        }}
        className="max-w-[calc(100%-2rem)] min-w-0 resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-[28px] font-semibold leading-tight text-foreground shadow-none outline-none ring-0 [field-sizing:content] placeholder:text-muted-foreground/50"
      />
      <span className="mt-1 shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={editNameLabel}
              onClick={() => titleRef.current?.focus()}
            >
              <Pencil className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {editNameLabel}
          </TooltipContent>
        </Tooltip>
      </span>
    </div>
  )
}

/** The left-hand column of the loop setup dialog: the loop's name and what it sends each iteration. */
export function LoopSetupPromptPane({
  draft,
  errors,
  update,
  namePlaceholder,
  warning,
  onDismiss
}: SectionProps & {
  /** The name the loop gets if the title is left empty. */
  namePlaceholder: string
  warning: string | null
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-8 py-6">
      {warning ? (
        <p
          role="status"
          className="mb-4 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
        >
          {warning}
        </p>
      ) : null}
      <LoopNameTitle
        value={draft.name}
        placeholder={namePlaceholder}
        onChange={(name) => update({ name })}
      />
      {draft.preset === 'queue' ? (
        <>
          <SectionLabel>{translate('fork.loops.setup.queueItems', 'Queue')}</SectionLabel>
          <div className="scrollbar-sleek min-h-0 flex-1 space-y-4 overflow-y-auto">
            <LoopSetupQueueItems draft={draft} errors={errors} update={update} />
            <CheckboxField
              id="loop-setup-repeat-queue"
              label={translate(
                'fork.loops.setup.repeatQueue',
                'Start over when the queue is empty'
              )}
              checked={draft.repeatQueue}
              onChange={(repeatQueue) => update({ repeatQueue })}
            />
          </div>
        </>
      ) : (
        <>
          <SectionLabel>{translate('fork.loops.setup.prompt', 'Prompt')}</SectionLabel>
          <AutomationEditorPromptEditor
            value={draft.prompt}
            placeholder={translate(
              'fork.loops.setup.promptPlaceholder',
              'What should the agent do on every iteration?'
            )}
            ariaLabel={translate('fork.loops.setup.prompt', 'Prompt')}
            onChange={(prompt) => update({ prompt })}
            onDismiss={onDismiss}
          />
          {errors.has('prompt') ? (
            <p className="mt-2 text-[11px] text-destructive">
              {translate('fork.loops.setup.errorPrompt', 'Enter a prompt to start the loop.')}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
