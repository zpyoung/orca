import { Terminal } from 'lucide-react'
import type {
  AgentLaunchOptionSelection,
  AgentLaunchOverrides
} from '../../../../shared/agent-launch-overrides'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type { CustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { CUSTOM_AGENT_ID, isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  SOURCE_CONTROL_ACTION_LABELS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import { AgentIcon } from '@/lib/agent-catalog'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { AgentLaunchOverridesFields } from '../agent-launch/AgentLaunchOverridesFields'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  actionRecipeDraftToAgentLaunchOverrides,
  agentLaunchOptionSelectionFromOverrides,
  type ActionRecipeDraftValue
} from './source-control-ai-action-recipe-draft'
import {
  getActionDescriptions,
  SOURCE_CONTROL_TEXT_ACTION_ID_SET,
  getAgentCatalogForAction,
  getSourceControlActionAgentSupportText,
  getSourceControlActionAgentWarningText,
  getSourceControlAgentArgsPlaceholder
} from './source-control-action-recipe-options'
import { translate } from '@/i18n/i18n'

const DEFAULT_AGENT_VALUE = '__default_agent__'

type SourceControlActionRecipeRowProps = {
  actionId: SourceControlActionId
  selectedAgent: TuiAgent | CustomAgentId | null
  draftValue: ActionRecipeDraftValue
  baseValue: ActionRecipeDraftValue
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  isSavingRecipe: boolean
  repoOverrideNote?: React.ReactNode
  onAgentChange: (actionId: SourceControlActionId, value: string) => void
  onTemplateChange: (actionId: SourceControlActionId, value: string) => void
  onAgentArgsChange: (actionId: SourceControlActionId, value: string) => void
  onLaunchOptionsChange: (
    actionId: SourceControlActionId,
    value: AgentLaunchOptionSelection
  ) => void
  onAppendVariable: (actionId: SourceControlActionId, variable: string) => void
  onDiscard: (actionId: SourceControlActionId) => void
  onSave: (actionId: SourceControlActionId) => void
}

function resolveAgentArgsPlaceholderAgent(
  selectedAgent: TuiAgent | CustomAgentId | null | undefined,
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
): TuiAgent | null {
  if (selectedAgent && !isCustomAgentId(selectedAgent)) {
    return selectedAgent
  }
  return defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : null
}

export function SourceControlActionRecipeRow({
  actionId,
  selectedAgent,
  draftValue,
  baseValue,
  defaultTuiAgent,
  isSavingRecipe,
  repoOverrideNote,
  onAgentChange,
  onTemplateChange,
  onAgentArgsChange,
  onLaunchOptionsChange,
  onAppendVariable,
  onDiscard,
  onSave
}: SourceControlActionRecipeRowProps): React.JSX.Element {
  const recipeDirty = JSON.stringify(draftValue) !== JSON.stringify(baseValue)
  const launchAgent = resolveAgentArgsPlaceholderAgent(selectedAgent, defaultTuiAgent)
  const launchOverrides = actionRecipeDraftToAgentLaunchOverrides(draftValue)
  const onLaunchOverridesChange = (
    updater: (current: AgentLaunchOverrides) => AgentLaunchOverrides
  ): void => {
    const next = updater(launchOverrides)
    const nextAgentArgs = next.agentArgs ?? ''
    if (nextAgentArgs !== draftValue.agentArgs) {
      onAgentArgsChange(actionId, nextAgentArgs)
    }
    const nextLaunchOptions = agentLaunchOptionSelectionFromOverrides(next)
    if (JSON.stringify(nextLaunchOptions) !== JSON.stringify(draftValue.launchOptions)) {
      onLaunchOptionsChange(actionId, nextLaunchOptions)
    }
  }
  const agentArgsPlaceholder = getSourceControlAgentArgsPlaceholder(launchAgent)
  const agentOptions = getAgentCatalogForAction(actionId, selectedAgent)
  const agentWarningText = getSourceControlActionAgentWarningText(actionId, selectedAgent)
  const agentSupportText = getSourceControlActionAgentSupportText(actionId)

  return (
    <div className="rounded-md border border-border px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-foreground">
            {SOURCE_CONTROL_ACTION_LABELS[actionId]}
          </p>
          <p className="text-[11px] text-muted-foreground">{getActionDescriptions()[actionId]}</p>
        </div>
        <div className="w-full shrink-0 space-y-1 sm:w-[220px]">
          <Select
            value={selectedAgent ?? DEFAULT_AGENT_VALUE}
            onValueChange={(value) => onAgentChange(actionId, value)}
          >
            <SelectTrigger size="sm" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_AGENT_VALUE}>
                <span className="flex items-center gap-2">
                  <Terminal className="size-3.5 text-muted-foreground" />
                  {translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
                    'Use default agent'
                  )}
                </span>
              </SelectItem>
              {SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId) ? (
                <SelectItem value={CUSTOM_AGENT_ID}>
                  <span className="flex items-center gap-2">
                    <Terminal className="size-3.5 text-muted-foreground" />
                    {translate(
                      'auto.components.settings.SourceControlAiActionRecipeDefaults.0740d30915',
                      'Custom command'
                    )}
                  </span>
                </SelectItem>
              ) : null}
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agent.id} size={14} />
                    {agent.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {agentWarningText ? (
            <p className="text-[11px] text-destructive">{agentWarningText}</p>
          ) : agentSupportText ? (
            <p className="text-[11px] text-muted-foreground">{agentSupportText}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr]">
        <AgentLaunchOverridesFields
          agent={launchAgent}
          value={launchOverrides}
          onChange={onLaunchOverridesChange}
          agentArgsPlaceholder={agentArgsPlaceholder}
          idPrefix={`source-control-action-${actionId}`}
        />
        <div className="space-y-2">
          <Label className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.SourceControlAiActionRecipeDefaults.fb09da4345',
              'Command template'
            )}
          </Label>
          <textarea
            value={draftValue.commandInputTemplate}
            rows={3}
            spellCheck={false}
            onChange={(event) => onTemplateChange(actionId, event.target.value)}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
          />
          <SourceControlActionVariableChips
            actionId={actionId}
            onInsert={(variable) => onAppendVariable(actionId, variable)}
          />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {repoOverrideNote}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {recipeDirty
              ? translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.817128d94e',
                  'Unsaved changes'
                )
              : translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.9d3cc627f8',
                  'Saved'
                )}
          </p>
          <div className="flex items-center gap-2">
            {recipeDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDiscard(actionId)}
                disabled={isSavingRecipe}
              >
                {translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.b3914ecbbc',
                  'Discard'
                )}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => onSave(actionId)}
              disabled={!recipeDirty || isSavingRecipe}
            >
              {isSavingRecipe
                ? translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.4f549a5fa8',
                    'Saving...'
                  )
                : translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.d18d665e12',
                    'Save'
                  )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
