import { ChevronDown } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AUTOMATION_EDITOR_PICKER_TRIGGER_CLASS } from '@/components/automations/AutomationEditorDialog'
import {
  AUTOMATION_EDITOR_SECTION_LABEL_CLASS,
  Field
} from '@/components/automations/automation-page-parts'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  defaultSessionPolicyForPreset,
  LoopPresetSchema,
  LoopSessionPolicySchema,
  type LoopPreset
} from '../../../shared/fork-loops/loop-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { IntervalFields } from './loop-config-fields'
import {
  LoopSetupAdvancedFields,
  wholeNumberError,
  type SectionProps
} from './LoopSetupAdvancedFields'

export function presetLabel(preset: LoopPreset): string {
  if (preset === 'interval') {
    return translate('fork.loops.setup.presetInterval', 'On an interval')
  }
  if (preset === 'queue') {
    return translate('fork.loops.setup.presetQueue', 'Queue')
  }
  return translate('fork.loops.setup.presetUntilDone', 'Until done')
}

function SegmentedTrack({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-md bg-muted p-0.5">{children}</div>
}

function SectionHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[11px] text-muted-foreground">{children}</p>
}

function RunField({ draft, errors, update }: SectionProps): React.JSX.Element {
  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate('fork.loops.setup.preset', 'Run')}
    >
      <SegmentedTrack>
        <ToggleGroup
          type="single"
          spacing={1}
          size="sm"
          className="grid w-full grid-cols-3"
          value={draft.preset}
          onValueChange={(value) => {
            const preset = LoopPresetSchema.safeParse(value)
            if (preset.success) {
              update({
                preset: preset.data,
                sessionPolicy: defaultSessionPolicyForPreset(preset.data)
              })
            }
          }}
        >
          {LoopPresetSchema.options.map((preset) => (
            <ToggleGroupItem key={preset} value={preset} aria-label={presetLabel(preset)}>
              <span className="truncate text-xs">{presetLabel(preset)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SegmentedTrack>
      {draft.preset === 'interval' ? (
        <div className="pt-2">
          <IntervalFields draft={draft} errors={errors} update={update} />
        </div>
      ) : null}
    </Field>
  )
}

function SessionField({ draft, update }: SectionProps): React.JSX.Element {
  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate('fork.loops.setup.session', 'Session')}
    >
      <SegmentedTrack>
        <ToggleGroup
          type="single"
          spacing={1}
          size="sm"
          className="grid w-full grid-cols-2"
          value={draft.sessionPolicy}
          onValueChange={(value) => {
            const policy = LoopSessionPolicySchema.safeParse(value)
            if (policy.success) {
              update({ sessionPolicy: policy.data })
            }
          }}
        >
          <ToggleGroupItem value="fresh">
            <span className="text-xs">
              {translate('fork.loops.setup.sessionFreshShort', 'Fresh')}
            </span>
          </ToggleGroupItem>
          <ToggleGroupItem value="continue">
            <span className="text-xs">
              {translate('fork.loops.setup.sessionContinueShort', 'Continue')}
            </span>
          </ToggleGroupItem>
        </ToggleGroup>
      </SegmentedTrack>
      <SectionHint>
        {draft.sessionPolicy === 'continue'
          ? translate('fork.loops.setup.sessionContinue', 'Continue the same session')
          : translate('fork.loops.setup.sessionFresh', 'Fresh session each iteration')}
      </SectionHint>
    </Field>
  )
}

function MaxIterationsSection({ draft, errors, update }: SectionProps): React.JSX.Element {
  const invalid = errors.has('iterations')
  return (
    <Field
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate('fork.loops.setup.maxIterations', 'Maximum iterations')}
    >
      <Input
        id="loop-setup-max-iterations"
        inputMode="numeric"
        aria-label={translate('fork.loops.setup.maxIterations', 'Maximum iterations')}
        aria-invalid={invalid}
        value={draft.maxIterations}
        onChange={(event) => update({ maxIterations: event.target.value })}
      />
      {invalid ? (
        <p className="text-[11px] text-destructive">{wholeNumberError()}</p>
      ) : (
        <SectionHint>
          {translate('fork.loops.setup.maxIterationsHint', 'Clear to run with no limit.')}
        </SectionHint>
      )}
    </Field>
  )
}

/** The right-hand settings column of the loop setup dialog, laid out like the automation editor's. */
export function LoopSetupSettingsSidebar({
  agents,
  agent,
  defaultAgent,
  showCost,
  showCheckpointCommits,
  onAgentChange,
  ...section
}: SectionProps & {
  agents: AgentCatalogEntry[]
  agent: TuiAgent | null
  defaultAgent: React.ComponentProps<typeof AgentCombobox>['defaultAgent']
  showCost: boolean
  showCheckpointCommits: boolean
  onAgentChange: (agent: TuiAgent | null) => void
}): React.JSX.Element {
  return (
    <aside className="scrollbar-sleek flex w-[320px] shrink-0 flex-col gap-5 overflow-auto border-l border-border/50 bg-muted/20 px-5 py-5">
      <Field
        labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
        label={translate('fork.loops.setup.agent', 'Agent')}
      >
        <AgentCombobox
          agents={agents}
          value={agent}
          onValueChange={onAgentChange}
          defaultAgent={defaultAgent}
          allowBlankTerminal={false}
          triggerClassName={`h-9 w-full min-w-0 ${AUTOMATION_EDITOR_PICKER_TRIGGER_CLASS}`}
          allowNarrowTrigger
        />
      </Field>
      <RunField {...section} />
      <SessionField {...section} />
      <MaxIterationsSection {...section} />
      <Collapsible>
        <CollapsibleTrigger variant="row">
          {translate('fork.loops.setup.advanced', 'Advanced')}
          <ChevronDown className="size-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <LoopSetupAdvancedFields
            {...section}
            showCost={showCost}
            showCheckpointCommits={showCheckpointCommits}
          />
        </CollapsibleContent>
      </Collapsible>
    </aside>
  )
}
