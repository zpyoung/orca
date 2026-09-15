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
import {
  isObjectiveLandingBarAvailable,
  OBJECTIVE_CAPABILITIES,
  OBJECTIVE_LANDING_BARS,
  OBJECTIVE_ROLES,
  OBJECTIVE_SITTER_CAPABILITIES,
  OBJECTIVE_TIERS,
  type ObjectiveEnrollmentDraft,
  type ObjectiveLandingBar
} from './objective-enrollment-model'
import type { ObjectiveWorkspaceOption } from './objective-workspace-options'
import {
  objectiveCapabilityLabel,
  objectiveCapabilityModeLabel,
  objectiveLandingBarLabel,
  objectiveRoleLabel,
  objectiveSitterCapabilityLabel,
  objectiveTierLabel,
  objectiveWorkspaceKindLabel
} from './objective-copy'

const CAPABILITY_MODES: readonly CapabilityMode[] = ['off', 'gated', 'on']

function CompactSelect({
  label,
  value,
  disabled,
  options,
  onChange
}: {
  label: string
  value: string
  disabled: boolean
  options: readonly { value: string; label: string; disabled?: boolean }[]
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
export type ObjectiveEnrollmentFieldsProps = {
  draft: ObjectiveEnrollmentDraft
  selectedWorkspaceKey: string
  workspaces: readonly ObjectiveWorkspaceOption[]
  agents: readonly AgentCatalogEntry[]
  disabled: boolean
  onWorkspaceChange: (key: string) => void
  onDraftChange: (draft: ObjectiveEnrollmentDraft) => void
}

export function ObjectiveEnrollmentFields({
  draft,
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
  const concurrencyId = useId()
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
        <Select value={selectedWorkspaceKey} disabled={disabled} onValueChange={onWorkspaceChange}>
          <SelectTrigger aria-labelledby={workspaceLabelId} className="w-full">
            <SelectValue
              placeholder={translate(
                'fork.heimdallObjective.enrollment.workspacePlaceholder',
                'Choose a workspace'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((workspace) => (
              <SelectItem
                key={workspace.key}
                value={workspace.key}
                disabled={workspace.ownerUnavailable}
              >
                <span className="block max-w-[460px]">
                  <span className="block truncate text-sm">{workspace.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {objectiveWorkspaceKindLabel(workspace.workspaceKind)} · {workspace.detail}
                    {workspace.ownerUnavailable
                      ? ` · ${translate(
                          'fork.heimdallObjective.enrollment.ownerUnavailableShort',
                          'Owner unavailable'
                        )}`
                      : ''}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          value={draft.landingBar}
          disabled={disabled}
          options={OBJECTIVE_LANDING_BARS.map((bar) => ({
            value: bar,
            label: objectiveLandingBarLabel(bar),
            disabled: !isObjectiveLandingBarAvailable(draft.workspaceKind, bar)
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
        <div className="grid grid-cols-[minmax(0,1fr)_148px] items-center gap-3">
          <div className="space-y-0.5">
            <Label htmlFor={concurrencyId}>
              {translate('fork.heimdallObjective.enrollment.maxConcurrency', 'Max concurrency')}
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'fork.heimdallObjective.enrollment.maxConcurrencyHelp',
                'Fixed at 1 while objective workers run serially.'
              )}
            </p>
          </div>
          <Input id={concurrencyId} value="1" readOnly disabled className="text-xs" />
        </div>
        <div className="space-y-2">
          <Label htmlFor={territoryId}>
            {translate('fork.heimdallObjective.enrollment.territory', 'Write territory')}
          </Label>
          <Textarea
            id={territoryId}
            rows={4}
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
              'One workspace-relative glob per line. .git, .orca, absolute paths, and parent traversal are refused.'
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
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('fork.heimdallObjective.enrollment.capabilities', 'Capabilities')}
        </h3>
        {OBJECTIVE_CAPABILITIES.map((capability) => (
          <CompactSelect
            key={capability}
            label={objectiveCapabilityLabel(capability)}
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
        ))}
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

      <section className="space-y-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.sitterOverrides',
              'Later landing overrides'
            )}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.sitterOverridesHelp',
              'Stored now for the higher landing rungs delivered in Phase 4.'
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
