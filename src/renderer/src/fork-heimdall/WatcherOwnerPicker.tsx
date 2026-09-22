import { useId } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import { WATCHER_OWNER_SUPPORTED_AGENT, type WatcherOwnerDraft } from './watcher-owner-draft'

const UNAVAILABLE_OWNER_HARNESS_IDS = ['codex', 'gemini', 'cursor', 'grok'] as const

type SelectOption = { value: string; label: string; disabled?: boolean }

function OwnerSelect({
  label,
  value,
  disabled,
  options,
  onChange
}: {
  label: string
  value: string
  disabled: boolean
  options: readonly SelectOption[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const labelId = useId()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_148px] items-center gap-3">
      <Label id={labelId} className="truncate text-xs">
        {label}
      </Label>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger aria-labelledby={labelId} size="sm" className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className="text-xs"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export type WatcherOwnerPickerProps = {
  draft: WatcherOwnerDraft
  disabled: boolean
  onChange: (draft: WatcherOwnerDraft) => void
}

/**
 * Picks the agent Heimdall wakes on a deviation instead of replanning automatically. Optional:
 * leaving it off keeps today's behavior. Only `claude` is offered; every other harness is listed
 * disabled with the reason, per the design's "list and explain" rule for unavailable options.
 */
export function WatcherOwnerPicker({
  draft,
  disabled,
  onChange
}: WatcherOwnerPickerProps): React.JSX.Element {
  const enabledId = useId()
  const agents = getAgentCatalog()
  const harnessLabel = (id: string): string => agents.find((agent) => agent.id === id)?.label ?? id
  const harnessOptions: SelectOption[] = [
    { value: WATCHER_OWNER_SUPPORTED_AGENT, label: harnessLabel(WATCHER_OWNER_SUPPORTED_AGENT) },
    ...UNAVAILABLE_OWNER_HARNESS_IDS.map((id) => ({
      value: id,
      label: harnessLabel(id),
      disabled: true
    }))
  ]

  const catalog = getAgentSessionOptionCatalog(WATCHER_OWNER_SUPPORTED_AGENT)
  const models = catalog?.models ?? []
  const modelOptions: SelectOption[] = [
    { value: '', label: translate('fork.heimdall.owner.modelAutomatic', 'Automatic') },
    ...models.map((model) => ({ value: model.id, label: model.label }))
  ]
  const selectedModel = models.find((model) => model.id === draft.model)
  const effortOption = selectedModel?.options.find((option) => option.id === 'effort')
  const effortChoices = effortOption?.kind.type === 'select' ? effortOption.kind.choices : []
  const effortOptions: SelectOption[] = [
    { value: '', label: translate('fork.heimdall.owner.effortAutomatic', 'Automatic') },
    ...effortChoices.map((choice) => ({ value: choice.value, label: choice.label }))
  ]

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor={enabledId}>
            {translate('fork.heimdall.owner.title', 'Owning agent')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'fork.heimdall.owner.help',
              'Optional. When set, Heimdall wakes this agent on a deviation instead of replanning automatically. Off keeps automatic replan-on-failure.'
            )}
          </p>
        </div>
        <Switch
          id={enabledId}
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
        />
      </div>
      {draft.enabled ? (
        <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
          <OwnerSelect
            label={translate('fork.heimdall.owner.harness', 'Harness')}
            value={WATCHER_OWNER_SUPPORTED_AGENT}
            disabled={disabled}
            options={harnessOptions}
            onChange={() => {}}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'fork.heimdall.owner.harnessUnavailableHelp',
              'Only Claude has a resumable session Heimdall can wake between turns. Other harnesses cannot own a watcher yet.'
            )}
          </p>
          <OwnerSelect
            label={translate('fork.heimdall.owner.model', 'Model')}
            value={draft.model}
            disabled={disabled || models.length === 0}
            options={modelOptions}
            onChange={(model) => onChange({ ...draft, model, effort: '' })}
          />
          {effortChoices.length > 0 ? (
            <OwnerSelect
              label={translate('fork.heimdall.owner.effort', 'Effort')}
              value={draft.effort}
              disabled={disabled}
              options={effortOptions}
              onChange={(effort) => onChange({ ...draft, effort })}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
