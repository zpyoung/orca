import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { OBJECTIVE_TEXT_MAX_LENGTH } from '../../../shared/fork-heimdall-objective/contract-types'
import type { CapabilityMode } from '../../../shared/fork-heimdall/watcher-types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { WatcherOwnerPicker } from '../fork-heimdall/WatcherOwnerPicker'
import {
  ObjectiveEnrollmentFieldHelp,
  objectiveCapabilityHelp,
  objectiveCapabilityModesHelp,
  objectiveLandingBarHelp,
  objectiveTerritoryHelp,
  objectiveTierHelp,
  type ObjectiveEnrollmentHelpCopy
} from './ObjectiveEnrollmentFieldHelp'
import { ObjectiveEnrollmentGateFields } from './ObjectiveEnrollmentGateFields'
import { ObjectiveExistingPlanInput } from './ObjectiveExistingPlanInput'
import { ObjectiveEnrollmentParallelFields } from './ObjectiveEnrollmentParallelFields'
import { ObjectiveWorkspacePicker } from './ObjectiveWorkspacePicker'
import {
  isObjectiveLandingBarAvailable,
  OBJECTIVE_CAPABILITIES,
  OBJECTIVE_LANDING_BARS,
  OBJECTIVE_ROLES,
  OBJECTIVE_SITTER_CAPABILITIES,
  OBJECTIVE_TIERS,
  type ObjectiveEnrollmentDraft,
  type ObjectiveLandingBarAvailability,
  type ObjectiveLandingBar
} from './objective-enrollment-model'
import type { ObjectiveWorkspaceOption } from './objective-workspace-options'
import {
  objectiveCapabilityLabel,
  objectiveCapabilityModeLabel,
  objectiveLandingBarLabel,
  objectiveRoleLabel,
  objectiveSitterCapabilityLabel,
  objectiveTierLabel
} from './objective-copy'

const CAPABILITY_MODES: readonly CapabilityMode[] = ['off', 'gated', 'on']

function CompactSelect({
  label,
  help,
  value,
  disabled,
  options,
  onChange
}: {
  label: string
  help?: ObjectiveEnrollmentHelpCopy
  value: string
  disabled: boolean
  options: readonly { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const labelId = useId()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_148px] items-center gap-3">
      <div className="flex min-w-0 items-center gap-1">
        <Label id={labelId} className="truncate text-xs">
          {label}
        </Label>
        {help ? <ObjectiveEnrollmentFieldHelp {...help} /> : null}
      </div>
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
export type ObjectiveEnrollmentFieldsProps = {
  draft: ObjectiveEnrollmentDraft
  landingAvailability: ObjectiveLandingBarAvailability
  selectedWorkspaceKey: string
  workspaces: readonly ObjectiveWorkspaceOption[]
  agents: readonly AgentCatalogEntry[]
  disabled: boolean
  onWorkspaceChange: (key: string) => void
  onDraftChange: (draft: ObjectiveEnrollmentDraft) => void
}

export function ObjectiveEnrollmentFields({
  draft,
  landingAvailability,
  selectedWorkspaceKey,
  workspaces,
  agents,
  disabled,
  onWorkspaceChange,
  onDraftChange
}: ObjectiveEnrollmentFieldsProps): React.JSX.Element {
  const objectiveId = useId()
  const workspaceLabelId = useId()
  const territoryId = useId()
  const activeBudgetId = useId()
  const activeBudgetInputId = useId()
  const turnBudgetId = useId()
  const roleOptions = [
    {
      value: 'automatic',
      label: translate('fork.heimdallObjective.enrollment.agentAutomatic', 'Automatic')
    },
    ...agents
      .filter((agent) => draft.availableAgentIds.includes(agent.id))
      .map((agent) => ({ value: agent.id, label: agent.label }))
  ]
  const capabilityOptions = CAPABILITY_MODES.map((mode) => ({
    value: mode,
    label: objectiveCapabilityModeLabel(mode)
  }))
  const sitterOptions = [
    {
      value: 'inherit',
      label: translate('fork.heimdallObjective.enrollment.inherit', 'Use landing defaults')
    },
    ...capabilityOptions
  ]
  const selectedWorkspace = workspaces.find((workspace) => workspace.key === selectedWorkspaceKey)
  const parallelUnsupported = selectedWorkspace?.parallelExecutionSupported === false

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="space-y-1">
          <Label id={workspaceLabelId}>
            {translate('fork.heimdallObjective.enrollment.workspace', 'Workspace')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.workspaceHelp',
              'The selected workspace and its owning host run every worker and check.'
            )}
          </p>
        </div>
        <ObjectiveWorkspacePicker
          value={selectedWorkspaceKey}
          workspaces={workspaces}
          disabled={disabled}
          labelledBy={workspaceLabelId}
          onChange={onWorkspaceChange}
        />
        {workspaces.length === 0 ? (
          <p className="text-xs text-muted-foreground" role="status">
            {translate(
              'fork.heimdallObjective.enrollment.noWorkspaces',
              'No eligible workspace is available.'
            )}
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor={objectiveId}>
            {translate('fork.heimdallObjective.enrollment.objective', 'Objective')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.objectiveHelp',
              'State the observable result the workers must deliver.'
            )}
          </p>
        </div>
        <Textarea
          id={objectiveId}
          rows={6}
          maxLength={OBJECTIVE_TEXT_MAX_LENGTH}
          value={draft.objectiveText}
          disabled={disabled}
          onChange={(event) =>
            onDraftChange({ ...draft, objectiveText: event.currentTarget.value })
          }
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('fork.heimdallObjective.enrollment.execution', 'Execution contract')}
        </h3>
        <CompactSelect
          label={translate('fork.heimdallObjective.enrollment.tier', 'Tier')}
          help={objectiveTierHelp()}
          value={draft.tier}
          disabled={disabled}
          options={OBJECTIVE_TIERS.map((tier) => ({
            value: tier,
            label: objectiveTierLabel(tier)
          }))}
          onChange={(tier) =>
            onDraftChange({ ...draft, tier: tier as ObjectiveEnrollmentDraft['tier'] })
          }
        />
        <CompactSelect
          label={translate('fork.heimdallObjective.enrollment.landingBar', 'Landing bar')}
          help={objectiveLandingBarHelp()}
          value={draft.landingBar}
          disabled={disabled}
          options={OBJECTIVE_LANDING_BARS.map((bar) => ({
            value: bar,
            label: objectiveLandingBarLabel(bar),
            disabled: !isObjectiveLandingBarAvailable(landingAvailability, bar)
          }))}
          onChange={(value) => {
            const landingBar = value as ObjectiveLandingBar
            onDraftChange({
              ...draft,
              landingBar,
              capabilities: {
                ...draft.capabilities,
                land: landingBar === 'files-on-disk' ? 'on' : 'gated'
              }
            })
          }}
        />
        <ObjectiveEnrollmentParallelFields
          draft={draft}
          disabled={disabled}
          parallelUnsupported={parallelUnsupported}
          onDraftChange={onDraftChange}
        />
        <ObjectiveEnrollmentGateFields
          draft={draft}
          disabled={disabled}
          parallelUnsupported={parallelUnsupported}
          onDraftChange={onDraftChange}
        />
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Label htmlFor={territoryId}>
              {translate(
                'fork.heimdallObjective.enrollment.territoryOptional',
                'Write territory (optional)'
              )}
            </Label>
            <ObjectiveEnrollmentFieldHelp {...objectiveTerritoryHelp()} />
          </div>
          <Textarea
            id={territoryId}
            rows={4}
            placeholder={translate(
              'fork.heimdallObjective.enrollment.territoryPlaceholder',
              'Whole workspace (default)'
            )}
            value={draft.writeTerritoryText}
            disabled={disabled}
            className="font-mono text-xs"
            onChange={(event) =>
              onDraftChange({ ...draft, writeTerritoryText: event.target.value })
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.territoryHelp',
              'Leave blank to allow the whole workspace. Otherwise enter one workspace-relative glob per line.'
            )}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('fork.heimdallObjective.enrollment.budgets', 'Budgets')}
        </h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label id={activeBudgetId} htmlFor={activeBudgetInputId}>
              {translate('fork.heimdallObjective.enrollment.activeBudget', 'Active work (hours)')}
            </Label>
            <Input
              id={activeBudgetInputId}
              type="number"
              min="0.25"
              step="0.25"
              value={Number.isFinite(draft.activeBudgetHours) ? draft.activeBudgetHours : ''}
              disabled={disabled}
              className="h-8 w-24 text-xs tabular-nums"
              onChange={(event) =>
                onDraftChange({ ...draft, activeBudgetHours: event.currentTarget.valueAsNumber })
              }
            />
          </div>
          <Slider
            aria-labelledby={activeBudgetId}
            min={0.25}
            max={Math.max(
              24,
              Number.isFinite(draft.activeBudgetHours) ? draft.activeBudgetHours : 0.25
            )}
            step={0.25}
            value={[
              Number.isFinite(draft.activeBudgetHours)
                ? Math.max(0.25, draft.activeBudgetHours)
                : 0.25
            ]}
            disabled={disabled}
            thumbLabels={[
              translate('fork.heimdallObjective.enrollment.activeBudget', 'Active work (hours)')
            ]}
            thumbValueLabels={[
              translate('fork.heimdallObjective.enrollment.activeBudgetA11y', '{{hours}} hours', {
                hours: draft.activeBudgetHours
              })
            ]}
            onValueChange={([hours]) =>
              onDraftChange({ ...draft, activeBudgetHours: hours ?? draft.activeBudgetHours })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={turnBudgetId}>
            {translate('fork.heimdallObjective.enrollment.turnBudget', 'Worker turn limit')}
          </Label>
          <Input
            id={turnBudgetId}
            type="number"
            min="0"
            step="1"
            value={draft.turns}
            disabled={disabled}
            onChange={(event) => onDraftChange({ ...draft, turns: event.target.value })}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('fork.heimdallObjective.enrollment.capabilities', 'Capabilities')}
          </h3>
          <ObjectiveEnrollmentFieldHelp {...objectiveCapabilityModesHelp()} />
        </div>
        {OBJECTIVE_CAPABILITIES.map((capability) => {
          const field = (
            <CompactSelect
              key={capability}
              label={objectiveCapabilityLabel(capability)}
              help={objectiveCapabilityHelp(capability)}
              value={draft.capabilities[capability]}
              disabled={disabled}
              options={capabilityOptions}
              onChange={(mode) =>
                onDraftChange({
                  ...draft,
                  capabilities: { ...draft.capabilities, [capability]: mode as CapabilityMode }
                })
              }
            />
          )
          return capability === 'plan' ? (
            <ObjectiveExistingPlanInput
              key={capability}
              value={draft.existingPlanText}
              planMode={draft.capabilities.plan}
              disabled={disabled}
              onChange={(existingPlanText) => onDraftChange({ ...draft, existingPlanText })}
            >
              {field}
            </ObjectiveExistingPlanInput>
          ) : (
            field
          )
        })}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('fork.heimdallObjective.enrollment.roleAgents', 'Role agents')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.roleAgentsHelp',
              'Automatic lets the owning host choose. Explicit choices are limited to agents detected there.'
            )}
          </p>
        </div>
        {OBJECTIVE_ROLES.map((role) => (
          <CompactSelect
            key={role}
            label={objectiveRoleLabel(role)}
            value={draft.roleAgents[role] || 'automatic'}
            disabled={disabled}
            options={roleOptions}
            onChange={(agentId) =>
              onDraftChange({
                ...draft,
                roleAgents: {
                  ...draft.roleAgents,
                  [role]: agentId === 'automatic' ? '' : agentId
                }
              })
            }
          />
        ))}
      </section>

      <WatcherOwnerPicker
        draft={draft.owner}
        disabled={disabled}
        onChange={(owner) => onDraftChange({ ...draft, owner })}
      />

      <section className="space-y-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.sitterOverrides',
              'Review watcher overrides'
            )}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.sitterOverridesHelp',
              'Applied to the review watcher enrolled when the run reaches its hosted-review rung.'
            )}
          </p>
        </div>
        {OBJECTIVE_SITTER_CAPABILITIES.map((capability) => (
          <CompactSelect
            key={capability}
            label={objectiveSitterCapabilityLabel(capability)}
            value={draft.sitterOverrides[capability]}
            disabled={disabled}
            options={sitterOptions}
            onChange={(mode) =>
              onDraftChange({
                ...draft,
                sitterOverrides: {
                  ...draft.sitterOverrides,
                  [capability]: mode as CapabilityMode | 'inherit'
                }
              })
            }
          />
        ))}
      </section>
    </div>
  )
}
