import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AgentLaunchOverrides } from '../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  buildAgentLaunchOverridesFieldState,
  type AgentLaunchFieldEntry,
  type AgentLaunchOptionDescriptor
} from './agent-launch-overrides-field-state'

export type AgentLaunchOverridesFieldsProps = {
  agent: TuiAgent | null
  value: AgentLaunchOverrides
  onChange: (updater: (current: AgentLaunchOverrides) => AgentLaunchOverrides) => void
  agentArgsPlaceholder?: string
  inheritedAgentArgs?: string | null
  reuseSessionNote?: boolean
  disabled?: boolean
  disabledReason?: string
  className?: string
  idPrefix: string
}

const INHERIT_SELECT_VALUE = 'inherit:'

function entryKey(value: SessionOptionValue | undefined): string {
  if (value === undefined) {
    return INHERIT_SELECT_VALUE
  }
  return typeof value === 'boolean' ? `boolean:${value}` : `string:${value}`
}

function setModel(
  current: AgentLaunchOverrides,
  model: SessionOptionValue | undefined
): AgentLaunchOverrides {
  const next = { ...current }
  if (typeof model === 'string') {
    next.model = model
  } else {
    delete next.model
  }
  return next
}

function setOptionValue(
  current: AgentLaunchOverrides,
  id: string,
  value: SessionOptionValue | undefined
): AgentLaunchOverrides {
  const optionValues = { ...current.optionValues }
  if (value === undefined) {
    delete optionValues[id]
  } else {
    optionValues[id] = value
  }
  const next = { ...current }
  if (Object.keys(optionValues).length > 0) {
    next.optionValues = optionValues
  } else {
    delete next.optionValues
  }
  return next
}

function setAgentArgs(current: AgentLaunchOverrides, agentArgs: string): AgentLaunchOverrides {
  const next = { ...current }
  if (agentArgs.length > 0) {
    next.agentArgs = agentArgs
  } else {
    delete next.agentArgs
  }
  return next
}

function entryLabel(entry: AgentLaunchFieldEntry, defaultLabel: string): string {
  if (entry.value === undefined) {
    return defaultLabel
  }
  if (typeof entry.value === 'boolean') {
    return entry.value
      ? translate('auto.components.agent.launch.AgentLaunchOverridesFields.on', 'On')
      : translate('auto.components.agent.launch.AgentLaunchOverridesFields.off', 'Off')
  }
  return entry.label ?? entry.value
}

function SelectEntryBody(props: {
  entry: AgentLaunchFieldEntry
  defaultLabel: string
}): React.JSX.Element {
  return (
    <span className="min-w-0 py-0.5">
      <span className="block">{entryLabel(props.entry, props.defaultLabel)}</span>
      {props.entry.description ? (
        <span className="block text-xs font-normal text-muted-foreground">
          {props.entry.description}
        </span>
      ) : null}
    </span>
  )
}

function LaunchSelect(props: {
  id: string
  entries: AgentLaunchFieldEntry[]
  value: SessionOptionValue | undefined
  defaultLabel: string
  disabled: boolean
  onChange: (value: SessionOptionValue | undefined) => void
}): React.JSX.Element {
  const selectedEntry = props.entries.find((entry) => entry.value === props.value)
  return (
    <Select
      value={entryKey(props.value)}
      disabled={props.disabled}
      onValueChange={(key) => {
        props.onChange(props.entries.find((entry) => entryKey(entry.value) === key)?.value)
      }}
    >
      <SelectTrigger id={props.id} className="w-full">
        <SelectValue>
          {selectedEntry ? entryLabel(selectedEntry, props.defaultLabel) : props.defaultLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {props.entries.map((entry) => (
          <SelectItem
            key={entryKey(entry.value)}
            value={entryKey(entry.value)}
            textValue={entryLabel(entry, props.defaultLabel)}
          >
            <SelectEntryBody entry={entry} defaultLabel={props.defaultLabel} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function OverriddenNote({ visible }: { visible: boolean }): React.JSX.Element | null {
  return visible ? (
    <div className="text-[11px] text-muted-foreground">
      {translate(
        'auto.components.agent.launch.AgentLaunchOverridesFields.setByCliArguments',
        'Set by CLI arguments'
      )}
    </div>
  ) : null
}

function OptionField(props: {
  descriptor: AgentLaunchOptionDescriptor
  id: string
  disabled: boolean
  shadowed: boolean
  onChange: (value: SessionOptionValue | undefined) => void
}): React.JSX.Element {
  const defaultLabel = translate(
    'auto.components.agent.launch.AgentLaunchOverridesFields.default',
    'Default'
  )
  const controlDisabled = props.disabled || props.shadowed
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={props.id}>{props.descriptor.label}</Label>
        {props.descriptor.description ? (
          <div className="text-xs text-muted-foreground">{props.descriptor.description}</div>
        ) : null}
      </div>
      <LaunchSelect
        id={props.id}
        entries={props.descriptor.entries}
        value={props.descriptor.value}
        defaultLabel={defaultLabel}
        disabled={controlDisabled}
        onChange={props.onChange}
      />
      <OverriddenNote visible={props.shadowed} />
    </div>
  )
}

function RawArgumentsField(props: {
  id: string
  value: string
  placeholder?: string
  inheritedValue?: string | null
  disabled: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>
        {translate(
          'auto.components.agent.launch.AgentLaunchOverridesFields.cliArguments',
          'CLI arguments'
        )}
      </Label>
      <Input
        id={props.id}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        className="h-8 font-mono text-xs"
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.inheritedValue != null ? (
        <div className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.agent.launch.AgentLaunchOverridesFields.inheritedHint',
            'Default: {{value0}}',
            { value0: props.inheritedValue }
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Render shared model, launch-option, and raw-argument override fields. */
export function AgentLaunchOverridesFields(
  props: AgentLaunchOverridesFieldsProps
): React.JSX.Element {
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(props.value.agentArgs?.trim()))
  useEffect(() => {
    if (props.value.agentArgs?.trim()) {
      setAdvancedOpen(true)
    }
  }, [props.value.agentArgs])

  const state = buildAgentLaunchOverridesFieldState(props.agent, props.value)
  const isCataloged = state.catalog !== null
  const rawArguments = (
    <RawArgumentsField
      id={`${props.idPrefix}-agent-args`}
      value={props.value.agentArgs ?? ''}
      placeholder={props.agentArgsPlaceholder}
      inheritedValue={props.inheritedAgentArgs}
      disabled={Boolean(props.disabled)}
      onChange={(agentArgs) => props.onChange((current) => setAgentArgs(current, agentArgs))}
    />
  )

  return (
    <div className={cn('space-y-2', props.className)}>
      {isCataloged ? (
        <div className="space-y-2">
          <Label htmlFor={`${props.idPrefix}-model`}>
            {translate('auto.components.agent.launch.AgentLaunchOverridesFields.model', 'Model')}
          </Label>
          <LaunchSelect
            id={`${props.idPrefix}-model`}
            entries={state.modelEntries}
            value={props.value.model}
            defaultLabel={translate(
              'auto.components.agent.launch.AgentLaunchOverridesFields.defaultFromSettings',
              'Default (from Settings)'
            )}
            disabled={Boolean(props.disabled || state.shadowedIds.has('model'))}
            onChange={(model) => props.onChange((current) => setModel(current, model))}
          />
          <OverriddenNote visible={state.shadowedIds.has('model')} />
          {state.unknownModelId ? (
            <div
              className={cn(
                'text-[11px]',
                state.catalog?.unknownModelOptions ? 'text-muted-foreground' : 'text-destructive'
              )}
            >
              {translate(
                'auto.components.agent.launch.AgentLaunchOverridesFields.staleModel',
                'Saved model {{value0}} is not in the current model list.',
                { value0: state.unknownModelId }
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {state.optionDescriptors.map((descriptor) => (
        <OptionField
          key={descriptor.id}
          descriptor={descriptor}
          id={`${props.idPrefix}-option-${descriptor.id}`}
          disabled={Boolean(props.disabled)}
          shadowed={state.shadowedIds.has(descriptor.id)}
          onChange={(optionValue) =>
            props.onChange((current) => setOptionValue(current, descriptor.id, optionValue))
          }
        />
      ))}

      {isCataloged ? (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.disabled}
              className="px-2 text-xs"
            >
              <ChevronDown
                className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
              />
              {translate(
                'auto.components.agent.launch.AgentLaunchOverridesFields.advanced',
                'Advanced'
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">{rawArguments}</CollapsibleContent>
        </Collapsible>
      ) : (
        rawArguments
      )}

      {props.disabled && props.disabledReason ? (
        <div className="text-xs text-muted-foreground">{props.disabledReason}</div>
      ) : null}
      {props.reuseSessionNote ? (
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.agent.launch.AgentLaunchOverridesFields.reuseSessionNote',
            "Applies when the session first starts. Reused runs keep the session's original settings."
          )}
        </div>
      ) : null}
    </div>
  )
}
