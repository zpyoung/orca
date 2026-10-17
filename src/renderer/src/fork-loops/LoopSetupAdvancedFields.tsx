import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { LoopPreset, LoopSessionPolicy } from '../../../shared/fork-loops/loop-types'
import type { TuiAgent } from '../../../shared/tui-agent'

export type QueueDraftItem = { key: string; body: string }

export type LoopSetupDraft = {
  name: string
  agent: TuiAgent | null
  preset: LoopPreset
  prompt: string
  repeatQueue: boolean
  queueItems: QueueDraftItem[]
  intervalMinutes: string
  anchor: 'from-end' | 'wall-clock'
  sessionPolicy: LoopSessionPolicy
  maxIterations: string
  maxActiveMinutes: string
  maxCostUsd: string
  checkCommand: string
  checkTimeoutSeconds: string
  checkRunWhen: 'every-iteration' | 'on-claim'
  evaluatorCondition: string
  protectedPaths: string
  noProgress: boolean
  checkpointCommits: boolean
  askBeforeNext: boolean
  resumeAtLimitReset: boolean
}

export type FieldError =
  | 'prompt'
  | 'queue'
  | 'queueItem'
  | 'interval'
  | 'iterations'
  | 'activeMinutes'
  | 'cost'
  | 'checkTimeout'

export type FieldProps = { label: string; hint?: string; error?: string }

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children
}: FieldProps & { htmlFor?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}

export function TextField({
  id,
  value,
  rows,
  placeholder,
  inputMode,
  onChange,
  ...field
}: FieldProps & {
  id: string
  value: string
  rows?: number
  placeholder?: string
  inputMode?: 'numeric' | 'decimal'
  onChange: (value: string) => void
}): React.JSX.Element {
  const control = { id, value, placeholder, inputMode, 'aria-invalid': field.error !== undefined }
  return (
    <Field htmlFor={id} {...field}>
      {rows ? (
        <Textarea {...control} rows={rows} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input {...control} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  )
}

export function SelectField({
  value,
  options,
  placeholder,
  onChange,
  ...field
}: FieldProps & {
  value: string
  options: readonly { value: string; label: string }[]
  placeholder?: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <Field {...field}>
      <Select value={value} disabled={options.length === 0} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  )
}

export type SectionProps = {
  draft: LoopSetupDraft
  errors: ReadonlySet<FieldError>
  update: (patch: Partial<LoopSetupDraft>) => void
}

export function wholeNumberError(): string {
  return translate('fork.loops.setup.errorWholeNumber', 'Enter a whole number of at least 1.')
}

/** Ordered, editable list of prompts a queue loop sends one per iteration. */
export function LoopSetupQueueItems({ draft, errors, update }: SectionProps): React.JSX.Element {
  const [pending, setPending] = useState('')
  const items = draft.queueItems
  const setItems = (queueItems: QueueDraftItem[]): void => update({ queueItems })
  const add = (): void => {
    if (pending.trim() === '') {
      return
    }
    setItems([...items, { key: createBrowserUuid(), body: pending }])
    setPending('')
  }
  const move = (index: number, offset: -1 | 1): void => {
    const next = [...items]
    const [moved] = next.splice(index, 1)
    next.splice(index + offset, 0, moved)
    setItems(next)
  }
  const error = errors.has('queue')
    ? translate('fork.loops.setup.errorQueueEmpty', 'Add at least one prompt to the queue.')
    : errors.has('queueItem')
      ? translate('fork.loops.setup.errorQueueBlankItem', 'Queue prompts cannot be blank.')
      : undefined
  return (
    <Field label={translate('fork.loops.setup.queueItems', 'Queue')} error={error}>
      <ol className="space-y-2">
        {items.map((item, index) => {
          const position = index + 1
          return (
            <li key={item.key} className="flex items-start gap-2">
              <Textarea
                rows={2}
                value={item.body}
                aria-label={translate('fork.loops.setup.queueItem', 'Queue item {{n}}', {
                  n: position
                })}
                aria-invalid={item.body.trim() === ''}
                onChange={(event) =>
                  setItems(
                    items.map((entry) =>
                      entry.key === item.key ? { ...entry, body: event.target.value } : entry
                    )
                  )
                }
              />
              <div className="flex shrink-0 flex-col gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={index === 0}
                  aria-label={translate(
                    'fork.loops.setup.queueMoveUp',
                    'Move queue item {{n}} up',
                    {
                      n: position
                    }
                  )}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={index === items.length - 1}
                  aria-label={translate(
                    'fork.loops.setup.queueMoveDown',
                    'Move queue item {{n}} down',
                    { n: position }
                  )}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate('fork.loops.setup.queueRemove', 'Remove queue item {{n}}', {
                    n: position
                  })}
                  onClick={() => setItems(items.filter((entry) => entry.key !== item.key))}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="flex items-start gap-2">
        <Textarea
          rows={2}
          value={pending}
          placeholder={translate(
            'fork.loops.setup.queueNewPlaceholder',
            'A prompt for one iteration'
          )}
          aria-label={translate('fork.loops.setup.queueNew', 'New queue item')}
          onChange={(event) => setPending(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending.trim() === ''}
          onClick={add}
        >
          <Plus />
          {translate('fork.loops.setup.queueAdd', 'Add to queue')}
        </Button>
      </div>
    </Field>
  )
}

export function LoopSetupAdvancedFields({
  draft,
  errors,
  update,
  showCost,
  showCheckpointCommits
}: SectionProps & { showCost: boolean; showCheckpointCommits: boolean }): React.JSX.Element {
  const flags = [
    {
      field: 'noProgress',
      label: translate('fork.loops.setup.noProgress', 'Pause after 3 iterations with no changes')
    },
    ...(showCheckpointCommits
      ? [
          {
            field: 'checkpointCommits',
            label: translate(
              'fork.loops.setup.checkpointCommits',
              'Commit a checkpoint after each iteration'
            )
          } as const
        ]
      : []),
    {
      field: 'askBeforeNext',
      label: translate('fork.loops.setup.askBeforeNext', 'Ask before each new iteration')
    },
    {
      field: 'resumeAtLimitReset',
      label: translate('fork.loops.setup.resumeAtLimitReset', 'Resume when the usage limit resets')
    }
  ] as const
  return (
    <div className="space-y-4 pt-2">
      <TextField
        id="loop-setup-check-command"
        label={translate('fork.loops.setup.checkCommand', 'Done check command')}
        hint={translate(
          'fork.loops.setup.checkHint',
          'Runs in the workspace. Exit code 0 means the work is done.'
        )}
        value={draft.checkCommand}
        onChange={(checkCommand) => update({ checkCommand })}
      />
      {draft.checkCommand.trim() !== '' ? (
        <div className="grid grid-cols-2 gap-3">
          <TextField
            inputMode="numeric"
            id="loop-setup-check-timeout"
            label={translate('fork.loops.setup.checkTimeout', 'Check timeout (seconds)')}
            value={draft.checkTimeoutSeconds}
            error={
              errors.has('checkTimeout')
                ? translate('fork.loops.setup.errorCheckTimeout', 'Enter 1 to 600 seconds.')
                : undefined
            }
            onChange={(checkTimeoutSeconds) => update({ checkTimeoutSeconds })}
          />
          <SelectField
            label={translate('fork.loops.setup.checkRunWhen', 'Run the check')}
            value={draft.checkRunWhen}
            options={[
              {
                value: 'every-iteration',
                label: translate('fork.loops.setup.runEveryIteration', 'After every iteration')
              },
              {
                value: 'on-claim',
                label: translate('fork.loops.setup.runOnClaim', 'When the agent says it is done')
              }
            ]}
            onChange={(value) =>
              update({ checkRunWhen: value === 'on-claim' ? 'on-claim' : 'every-iteration' })
            }
          />
        </div>
      ) : null}
      <TextField
        id="loop-setup-evaluator"
        rows={2}
        label={translate('fork.loops.setup.evaluator', 'Done condition')}
        hint={translate(
          'fork.loops.setup.evaluatorHint',
          'A second agent reads the changes and judges whether this is true.'
        )}
        value={draft.evaluatorCondition}
        onChange={(evaluatorCondition) => update({ evaluatorCondition })}
      />
      <TextField
        inputMode="numeric"
        id="loop-setup-max-active"
        label={translate('fork.loops.setup.maxActiveMinutes', 'Maximum active minutes')}
        value={draft.maxActiveMinutes}
        error={errors.has('activeMinutes') ? wholeNumberError() : undefined}
        onChange={(maxActiveMinutes) => update({ maxActiveMinutes })}
      />
      {showCost ? (
        <TextField
          inputMode="decimal"
          id="loop-setup-max-cost"
          label={translate('fork.loops.setup.maxCost', 'Maximum cost (USD)')}
          value={draft.maxCostUsd}
          error={
            errors.has('cost')
              ? translate('fork.loops.setup.errorCost', 'Enter an amount above 0.')
              : undefined
          }
          onChange={(maxCostUsd) => update({ maxCostUsd })}
        />
      ) : null}
      <TextField
        id="loop-setup-protected"
        rows={2}
        label={translate('fork.loops.setup.protectedPaths', 'Protected paths')}
        hint={translate(
          'fork.loops.setup.protectedPathsHint',
          'One path or glob per line. The loop pauses if the agent changes one.'
        )}
        value={draft.protectedPaths}
        onChange={(protectedPaths) => update({ protectedPaths })}
      />
      <div className="space-y-2">
        {flags.map(({ field, label }) => (
          <CheckboxField
            key={field}
            id={`loop-setup-${field}`}
            label={label}
            checked={draft[field]}
            onChange={(checked) => update({ [field]: checked })}
          />
        ))}
      </div>
    </div>
  )
}
