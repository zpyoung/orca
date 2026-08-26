import React from 'react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentLaunchOverridesFields } from '@/components/agent-launch/AgentLaunchOverridesFields'
import {
  getTuiAgentDefaultArgs,
  resolveTuiAgentLaunchArgs
} from '../../../../shared/tui-agent-launch-defaults'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { Field } from './automation-page-parts'
import { AutomationMissedRunGraceField } from './AutomationMissedRunGraceField'
import { AutomationSessionField } from './AutomationSessionField'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationAgentLaunchFieldsProps = {
  draft: AutomationDraft
  settings: GlobalSettings | null
  visibleAgents: AgentCatalogEntry[]
  scheduleField: React.ReactNode
  pickerTriggerClassName: string
  modeToggleItemClassName: string
  launchOverridesDisabled: boolean
  launchOverridesDisabledReason?: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

/** Render Orca automation agent, session, schedule, and launch settings. */
export function AutomationAgentLaunchFields({
  draft,
  settings,
  visibleAgents,
  scheduleField,
  pickerTriggerClassName,
  modeToggleItemClassName,
  launchOverridesDisabled,
  launchOverridesDisabledReason,
  onDraftChange
}: AutomationAgentLaunchFieldsProps): React.JSX.Element {
  const changeAgent = (agentId: TuiAgent): void => {
    onDraftChange((current) => ({
      ...current,
      agentId,
      launchOverrides: current.launchOverrides.agentArgs
        ? { agentArgs: current.launchOverrides.agentArgs }
        : {}
    }))
  }

  return (
    <>
      <div className="grid gap-3 pt-3 transition-[opacity,transform] duration-150 ease-out sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label={translate(
            'auto.components.automations.AutomationEditorDialog.57b722cbba',
            'Agent'
          )}
        >
          <AgentCombobox
            agents={visibleAgents}
            value={draft.agentId}
            onValueChange={(agentId) => agentId && changeAgent(agentId)}
            defaultAgent={settings?.defaultTuiAgent ?? null}
            triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
            allowNarrowTrigger
          />
        </Field>
        <AutomationSessionField
          draft={draft}
          toggleItemClassName={modeToggleItemClassName}
          onDraftChange={onDraftChange}
        />
        {scheduleField}
        <AutomationMissedRunGraceField
          draft={draft}
          disabled={false}
          pickerTriggerClassName={pickerTriggerClassName}
          onDraftChange={onDraftChange}
        />
      </div>
      <AgentLaunchOverridesFields
        className="pt-3"
        agent={draft.agentId}
        value={draft.launchOverrides}
        onChange={(updater) =>
          onDraftChange((current) => ({
            ...current,
            launchOverrides: updater(current.launchOverrides)
          }))
        }
        agentArgsPlaceholder={getTuiAgentDefaultArgs(draft.agentId)}
        inheritedAgentArgs={resolveTuiAgentLaunchArgs(draft.agentId, settings?.agentDefaultArgs)}
        reuseSessionNote={draft.workspaceMode === 'existing' && draft.reuseSession}
        disabled={launchOverridesDisabled}
        disabledReason={launchOverridesDisabledReason}
        idPrefix="automation-launch"
      />
    </>
  )
}
