import {
  canonicalSourceControlActionSelection,
  commitSourceControlActionArguments,
  editSourceControlActionArguments,
  pickSourceControlActionAgent,
  selectSourceControlActionRecipe,
  type CurrentActionSelection
} from '../../../../shared/source-control-action-selection'
import { captureSourceControlActionSelection } from '../../../../shared/source-control-ai-operation-policy'
import { useCallback, useMemo, useState } from 'react'
import { resolveSourceControlLaunchAgentScope } from '../../../../shared/source-control-launch-agent-selection'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import type { AgentLaunchOverrides } from '../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import { renderSourceControlActionCommandTemplate } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import { savedSurfaceForPick } from '@/lib/source-control-agent-picker'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import type { UseSourceControlAgentActionDialogResult } from './source-control-agent-action-dialog-result'
import {
  buildSourceControlAgentSaveTargets,
  buildSourceControlAgentScopeNote,
  buildSourceControlAgentStatusCopy
} from './source-control-agent-action-dialog-support'
import { useSourceControlAgentActionStart } from './useSourceControlAgentActionStart'
import {
  useAgentLaunchOptionSelection,
  useSourceControlAgentActionDraftEdits,
  useStableAgentLaunchOptionSelection
} from './fork-automation-launch-settings/useSourceControlAgentActionDraftEdits'

const DEFAULT_SAVE_TARGET_VALUE = 'global'

export function useSourceControlAgentActionDialog({
  open,
  initialRecipe: capturedRecipe,
  initialSelection,
  onOpenChange,
  actionId,
  baseCommandInput,
  savedCommandInputTemplate,
  savedAgentArgs,
  savedLaunchOptions,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  promptDelivery = 'submit-after-ready',
  launchPlatform,
  launchSource,
  recoveryContext,
  onSaveAgentDefault,
  onLaunchAccepted,
  onLaunchAborted,
  onLaunched,
  onStart
}: SourceControlAgentActionDialogProps): UseSourceControlAgentActionDialogResult {
  const settings = useAppStore((state) => state.settings)
  const repo = useRepoById(repoId ?? null)
  const [currentSelection, setCurrentSelection] = useState<CurrentActionSelection>(
    () =>
      initialSelection ??
      (capturedRecipe
        ? canonicalSourceControlActionSelection(capturedRecipe)
        : captureSourceControlActionSelection({ settings, repo, actionId }))
  )
  const recipe = useMemo(
    () => selectSourceControlActionRecipe(currentSelection),
    [currentSelection]
  )
  const [argumentsEdited, setArgumentsEdited] = useState(false)
  const [livePick, setLivePick] = useState<AgentLaunchSurface | undefined>(undefined)
  const commandTemplate = recipe.commandInputTemplate ?? '{basePrompt}'
  const agentArgs = recipe.agentArgs ?? ''
  const saveTargets = useMemo(() => buildSourceControlAgentSaveTargets(repoId), [repoId])
  const [saveLaunchRecipe, setSaveLaunchRecipe] = useState(true)
  const [explicitSaveTarget, setSaveTargetValue] = useState<string>()
  const connectionUnavailable = Boolean(worktreeId && connectionId === undefined)

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

  const choice = useSourceControlActionAgentChoice({
    open,
    worktreeId,
    repoId,
    repo,
    recipe,
    livePick,
    settings
  })
  const launchAgentScope = useMemo(
    () =>
      resolveSourceControlLaunchAgentScope({
        settings: { ...settings, ...choice.observation.preferences },
        repo,
        actionId
      }),
    [actionId, repo, settings, choice.observation.preferences]
  )
  // Update existing repo overrides in place; a new global default would remain shadowed.
  const defaultSaveTargetValue =
    launchAgentScope.overridesGlobalAgent && repoId ? 'repo' : DEFAULT_SAVE_TARGET_VALUE
  const [commandTemplate, setCommandTemplate] = useState(
    savedCommandInputTemplate ?? '{basePrompt}'
  )
  const stableSavedLaunchOptions = useStableAgentLaunchOptionSelection(savedLaunchOptions)
  const [launchOverrides, setLaunchOverrides] = useState<AgentLaunchOverrides>({
    ...savedLaunchOptions,
    ...(savedAgentArgs ? { agentArgs: savedAgentArgs } : {})
  })
  const agentArgs = launchOverrides.agentArgs ?? ''
  const launchOptions = useAgentLaunchOptionSelection(launchOverrides)
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(savedAgentId ?? null)
  const openCycleRef = useRef(0)
  const wasOpenRef = useRef(false)
  const [openCycle, setOpenCycle] = useState(0)
  // The open cycle's current discovery attempt; only its success may auto-pick or auto-start.
  const [discovery, setDiscovery] = useState<{ cycle: number; outcome: DiscoveryOutcome }>()
  const saveTargets = useMemo(() => buildSourceControlAgentSaveTargets(repoId), [repoId])
  const [saveLaunchRecipe, setSaveLaunchRecipe] = useState(true)
  const [saveTargetValue, setSaveTargetValue] = useState(defaultSaveTargetValue)

  const disabledAgents = settings?.disabledTuiAgents
  const connectionUnavailable = Boolean(worktreeId && connectionId === undefined)

  const executionHostId = repo ? getRepoExecutionHostId(repo) : undefined
  const { detecting, refreshAgents, refreshLaunchableAgents, launchableAgents } =
    useSourceControlLaunchableAgents({
      target: { worktreeId, repoId, executionHostId },
      connectionId,
      connectionUnavailable,
      active: open
    })

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    const cycle = wasOpenRef.current ? openCycleRef.current : openCycleRef.current + 1
    if (!wasOpenRef.current) {
      openCycleRef.current = cycle
      setOpenCycle(cycle)
    }
    wasOpenRef.current = true
    setDiscovery({ cycle, outcome: 'pending' })
    setCommandTemplate(savedCommandInputTemplate ?? '{basePrompt}')
    setLaunchOverrides({
      ...stableSavedLaunchOptions,
      ...(savedAgentArgs ? { agentArgs: savedAgentArgs } : {})
    })
    setSelectedAgent(savedAgentId ?? null)
    setSaveLaunchRecipe(true)
    setSaveTargetValue(defaultSaveTargetValue)
    let stale = false
    // Settle CLI-argument applicability with discovery so structured launches never flash an inapplicable field.
    void refreshAgents().then(
      ({ detected, launchable }) => {
        if (stale || openCycleRef.current !== cycle) {
          return
        }
        setSelectedAgent(
          (current) =>
            current ??
            pickSourceControlLaunchAgent({
              savedAgent: savedAgentId,
              defaultAgent: settings?.defaultTuiAgent,
              detectedAgents: detected,
              disabledAgents,
              chosenOpensAsChat: (agent) => launchable.includes(agent)
            })
        )
        setDiscovery({ cycle, outcome: 'success' })
      },
      (error: unknown) => {
        if (!stale && openCycleRef.current === cycle) {
          const cancelled = error instanceof AgentLaunchChoiceCancelled
          setDiscovery({ cycle, outcome: cancelled ? 'cancelled' : 'failed' })
        }
      }
    )
    return () => {
      stale = true
    }
  }, [
    defaultSaveTargetValue,
    disabledAgents,
    open,
    refreshAgents,
    savedAgentId,
    savedAgentArgs,
    stableSavedLaunchOptions,
    savedCommandInputTemplate,
    repoId,
    settings?.defaultTuiAgent
  ])

  const closeDialog = useCallback(() => onOpenChange(false), [onOpenChange])

  const { agentOptions, selectedAgentUnavailable, hasEnabledAgents } = useMemo(
    () =>
      buildSourceControlAgentAvailability({
        detectedAgents: launchableAgents,
        disabledAgents,
        selectedAgent
      }),
    [launchableAgents, disabledAgents, selectedAgent]
  )
  const commandInput = renderSourceControlActionCommandTemplate(commandTemplate, {
    basePrompt: baseCommandInput
  })
  const trimmedCommandInput = commandInput.trim()
  // Recompute from live store/runtime capabilities each render; structured chat ignores CLI arguments and these inputs are not dependency-tracked.
  const agentArgsApply = sourceControlLaunchAppliesAgentArgs({
    agent: selectedAgent,
    worktreeId,
    repoId,
    ...(repo ? { executionHostId: getRepoExecutionHostId(repo) } : {})
  })

  const {
    deliveryPlan,
    resetDeliveryPlan,
    cancelStart,
    isStarting,
    handleStart,
    startWithDetectedAgents
  } = useSourceControlAgentActionStart({
    open,
    connectionId,
    selectedAgent,
    commandInput,
    trimmedCommandInput,
    agentArgs,
    agentArgsApply,
    launchOptions,
    commandTemplate,
    saveLaunchRecipe,
    saveTargetValue,
    actionId,
    repoId,
    settings,
    repo,
    worktreeId,
    groupId,
    promptDelivery,
    launchPlatform,
    // SSH uses plain orca; preview must match instead of applying the local Linux orca-ide rename.
    isRemote: typeof connectionId === 'string',
    launchSource,
    recoveryContext,
    connectionUnavailable,
    refreshDetectedAgents: refreshLaunchableAgents,
    onStart,
    onSaveAgentDefault,
    onLaunchAccepted,
    onLaunchAborted,
    onLaunched,
    onClose: closeDialog
  })

  const canStart =
    Boolean(trimmedCommandInput) &&
    Boolean(selectedAgent) &&
    !choice.selectedAgentUnavailable &&
    !connectionUnavailable &&
    !detecting &&
    selection.ready &&
    !isStarting

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        cancelStart()
        resetDeliveryPlan()
        setSaveLaunchRecipe(true)
        setSaveTargetValue(defaultSaveTargetValue)
      }
      onOpenChange(nextOpen)
    },
    [cancelStart, defaultSaveTargetValue, onOpenChange, resetDeliveryPlan]
  )

  const discoveryOutcome = discovery?.cycle === openCycle ? discovery.outcome : 'pending'
  const { autoLaunchPending } = useSavedSourceControlAgentActionAutoStart({
    open,
    openCycle,
    detectionReady: discoveryOutcome === 'success',
    detectionFailed: discoveryOutcome === 'cancelled' || discoveryOutcome === 'failed',
    actionId,
    baseCommandInput,
    savedAgentId,
    savedCommandInputTemplate,
    savedAgentArgs,
    savedLaunchOptions,
    settings,
    repo,
    repoId,
    worktreeId,
    connectionId,
    selectedAgent,
    trimmedCommandInput,
    connectionUnavailable,
    detecting,
    isStarting,
    detectedAgents: launchableAgents,
    disabledAgents,
    onAutoStart: ({ detectedAgents: agentsForLaunch, saveTargetValue: matchedTargetValue }) =>
      startWithDetectedAgents({
        detectedAgents: agentsForLaunch,
        saveTargetValueOverride: matchedTargetValue
      })
  })

  const statusCopy = buildSourceControlAgentStatusCopy({
    selectedAgent,
    selectedAgentUnavailable: choice.selectedAgentUnavailable,
    connectionUnavailable,
    hasEnabledAgents: choice.hasEnabledAgents,
    detecting
  })

  // Why: editing any launch field invalidates the previewed delivery plan.
  const resetPlanAfter = useCallback(
    <T>(apply: (value: T) => void) =>
      (value: T): void => {
        apply(value)
        resetDeliveryPlan()
      },
    [resetDeliveryPlan]
  )
  const { onSelectedAgentChange, onLaunchOverridesChange } = useSourceControlAgentActionDraftEdits({
    resetDeliveryPlan,
    setSelectedAgent,
    setLaunchOverrides
  })
  const onCommandTemplateChange = useMemo(
    () => resetPlanAfter(setCommandTemplate),
    [resetPlanAfter]
  )
  const onSaveLaunchRecipeChange = useMemo(
    () => resetPlanAfter(setSaveLaunchRecipe),
    [resetPlanAfter]
  )

  const agentScopeNote = useMemo(
    () => buildSourceControlAgentScopeNote(launchAgentScope),
    [launchAgentScope]
  )

  return {
    handleOpenChange: (nextOpen) => {
      if (!nextOpen) {
        cancelStart()
      }
      onOpenChange(nextOpen)
    },
    agentScopeNote,
    agentOptions: choice.agentOptions,
    selectedAgent,
    hasEnabledAgents: choice.hasEnabledAgents,
    detecting,
    surfaceRows: {
      model: choice.observation.model,
      selection: choice.pickerSelection,
      contextKey: choice.observation.contextKey,
      surface: choice.liveSurface,
      onPick: onAgentPick
    },
    statusCopy,
    agentArgs,
    agentArgsApply,
    launchOptions,
    commandTemplate,
    recipe,
    saveLaunchRecipe,
    saveTargetValue,
    saveTargets,
    settings,
    repo,
    deliveryPlan,
    canStart,
    isStarting,
    onSelectedAgentChange,
    onLaunchOverridesChange,
    onCommandTemplateChange,
    onSaveLaunchRecipeChange,
    onSaveAgentDefaultChange: setSaveTargetValue,
    handleStart
  }
}
