import type { CurrentActionSelection } from '../../../../shared/source-control-action-selection'
import React from 'react'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { AgentLaunchOptionSelection } from '../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RunSourceControlAgentActionStartArgs } from './runSourceControlAgentActionStart'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { SourceControlAgentActionDialogForm } from './SourceControlAgentActionDialogForm'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'
import { translate } from '@/i18n/i18n'

export type SourceControlAgentActionDialogProps = {
  open: boolean
  initialRecipe?: SourceControlActionRecipe
  initialSelection?: CurrentActionSelection
  onOpenChange: (open: boolean) => void
  actionId: SourceControlLaunchActionId
  title: string
  description: string
  baseCommandInput: string
  savedCommandInputTemplate?: string | null
  savedAgentArgs?: string | null
  savedLaunchOptions?: AgentLaunchOptionSelection | null
  worktreeId?: string | null
  groupId?: string | null
  connectionId?: string | null
  repoId?: string | null
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  launchSource: LaunchSource
  /** Set only for paused-operation recovery, which must not start over Orca's own running Git work. */
  recoveryContext?: RuntimeGitContext | null
  savedAgentId?: TuiAgent | null
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSettings?: () => void
  /** Tab creation precedes prompt delivery: use reversible bookkeeping here; host writes belong in onLaunched. */
  onLaunchAccepted?: () => void
  /** Fires when an accepted launch later failed to deliver its prompt. */
  onLaunchAborted?: () => void
  onLaunched?: () => void
  startLabel?: string
<<<<<<< fork
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply to this launch, so it resolves the global setting. */
    agentArgs?: string
    launchOptions: AgentLaunchOptionSelection
  }) => boolean | Promise<boolean>
||||||| base
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply to this launch, so it resolves the global setting. */
    agentArgs?: string
  }) => boolean | Promise<boolean>
=======
  onStart?: RunSourceControlAgentActionStartArgs['onStart']
>>>>>>> upstream
}

export function SourceControlAgentActionDialog(
  props: SourceControlAgentActionDialogProps
): React.JSX.Element | null {
  return props.open ? <SourceControlAgentActionEditor {...props} /> : null
}

function SourceControlAgentActionEditor(
  props: SourceControlAgentActionDialogProps
): React.JSX.Element {
  const {
    open,
    actionId,
    title,
    description,
    baseCommandInput,
    savedCommandInputTemplate,
    onOpenSettings,
    startLabel = translate(
      'auto.components.right.sidebar.SourceControlAgentActionDialog.startAgent',
      'Start agent'
    ),
    onSaveAgentDefault
  } = props
  const {
    handleOpenChange,
    agentScopeNote,
    agentOptions,
    selectedAgent,
    hasEnabledAgents,
    detecting,
    surfaceRows,
    statusCopy,
    agentArgs,
    agentArgsApply,
<<<<<<< fork
    launchOptions,
||||||| base
=======
    recipe,
>>>>>>> upstream
    commandTemplate,
    saveLaunchRecipe,
    saveTargetValue,
    saveTargets,
    settings,
    repo,
    deliveryPlan,
    canStart,
    isStarting,
<<<<<<< fork
    onSelectedAgentChange,
    onLaunchOverridesChange,
||||||| base
    onSelectedAgentChange,
    onAgentArgsChange,
=======
    onAgentPick,
    onAgentArgsChange,
>>>>>>> upstream
    onCommandTemplateChange,
    onSaveLaunchRecipeChange,
    onSaveAgentDefaultChange,
    handleStart
  } = useSourceControlAgentActionDialog(props)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
<<<<<<< fork
      {/* Saved receipts auto-start; leave fallback content unmounted to prevent a dialog flash. */}
      {shouldRenderDialog ? (
        <DialogContent className="flex max-h-[min(82vh,42rem)] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">{description}</DialogDescription>
          </DialogHeader>
          <SourceControlAgentActionDialogForm
            actionId={actionId}
            baseCommandInput={baseCommandInput}
            agentScopeNote={agentScopeNote}
            agentOptions={agentOptions}
            selectedAgent={selectedAgent}
            hasEnabledAgents={hasEnabledAgents}
            detecting={detecting}
            statusCopy={statusCopy}
            agentArgs={agentArgs}
            agentArgsApply={agentArgsApply}
            launchOptions={launchOptions}
            commandTemplate={commandTemplate}
            savedCommandInputTemplate={savedCommandInputTemplate}
            saveLaunchRecipe={saveLaunchRecipe}
            saveTargetValue={saveTargetValue}
            saveTargets={saveTargets}
            settings={settings}
            repo={repo}
            canSaveAgentDefault={Boolean(onSaveAgentDefault)}
            deliveryPlan={deliveryPlan}
            canStart={canStart}
            isStarting={isStarting}
            startLabel={startLabel}
            onSelectedAgentChange={onSelectedAgentChange}
            onLaunchOverridesChange={onLaunchOverridesChange}
            onCommandTemplateChange={onCommandTemplateChange}
            onSaveLaunchRecipeChange={onSaveLaunchRecipeChange}
            onSaveAgentDefaultChange={onSaveAgentDefaultChange}
            onOpenSettings={onOpenSettings}
            onCancel={() => handleOpenChange(false)}
            onStart={() => void handleStart()}
          />
        </DialogContent>
      ) : null}
||||||| base
      {/* Saved receipts auto-start; leave fallback content unmounted to prevent a dialog flash. */}
      {shouldRenderDialog ? (
        <DialogContent className="flex max-h-[min(82vh,42rem)] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">{description}</DialogDescription>
          </DialogHeader>
          <SourceControlAgentActionDialogForm
            actionId={actionId}
            baseCommandInput={baseCommandInput}
            agentScopeNote={agentScopeNote}
            agentOptions={agentOptions}
            selectedAgent={selectedAgent}
            hasEnabledAgents={hasEnabledAgents}
            detecting={detecting}
            statusCopy={statusCopy}
            agentArgs={agentArgs}
            agentArgsApply={agentArgsApply}
            commandTemplate={commandTemplate}
            savedCommandInputTemplate={savedCommandInputTemplate}
            saveLaunchRecipe={saveLaunchRecipe}
            saveTargetValue={saveTargetValue}
            saveTargets={saveTargets}
            settings={settings}
            repo={repo}
            canSaveAgentDefault={Boolean(onSaveAgentDefault)}
            deliveryPlan={deliveryPlan}
            canStart={canStart}
            isStarting={isStarting}
            startLabel={startLabel}
            onSelectedAgentChange={onSelectedAgentChange}
            onAgentArgsChange={onAgentArgsChange}
            onCommandTemplateChange={onCommandTemplateChange}
            onSaveLaunchRecipeChange={onSaveLaunchRecipeChange}
            onSaveAgentDefaultChange={onSaveAgentDefaultChange}
            onOpenSettings={onOpenSettings}
            onCancel={() => handleOpenChange(false)}
            onStart={() => void handleStart()}
          />
        </DialogContent>
      ) : null}
=======
      <DialogContent className="flex max-h-[min(82vh,42rem)] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <SourceControlAgentActionDialogForm
          actionId={actionId}
          baseCommandInput={baseCommandInput}
          agentScopeNote={agentScopeNote}
          agentOptions={agentOptions}
          selectedAgent={selectedAgent}
          hasEnabledAgents={hasEnabledAgents}
          detecting={detecting}
          surfaceRows={surfaceRows}
          statusCopy={statusCopy}
          agentArgs={agentArgs}
          agentArgsApply={agentArgsApply}
          recipe={recipe}
          commandTemplate={commandTemplate}
          savedCommandInputTemplate={
            props.initialSelection?.current.commandInputTemplate ??
            props.initialRecipe?.commandInputTemplate ??
            savedCommandInputTemplate
          }
          saveLaunchRecipe={saveLaunchRecipe}
          saveTargetValue={saveTargetValue}
          saveTargets={saveTargets}
          settings={settings}
          repo={repo}
          canSaveAgentDefault={Boolean(onSaveAgentDefault)}
          deliveryPlan={deliveryPlan}
          canStart={canStart}
          isStarting={isStarting}
          startLabel={startLabel}
          onAgentPick={onAgentPick}
          onAgentArgsChange={onAgentArgsChange}
          onCommandTemplateChange={onCommandTemplateChange}
          onSaveLaunchRecipeChange={onSaveLaunchRecipeChange}
          onSaveAgentDefaultChange={onSaveAgentDefaultChange}
          onOpenSettings={onOpenSettings}
          onCancel={() => handleOpenChange(false)}
          onStart={() => void handleStart()}
        />
      </DialogContent>
>>>>>>> upstream
    </Dialog>
  )
}
