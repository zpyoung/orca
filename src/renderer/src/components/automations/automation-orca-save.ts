import { completeAutomationSave } from './automation-save-completion'
import {
  recordedAutomationRunContext,
  isSameAutomationWorkspace
} from './automation-recorded-target'
import { capturedAutomationOwner } from './automation-captured-owner'
import {
  automationChatSupport,
  automationDraftLaunchSetup,
  automationLaunchWorkspace
} from './automation-launch-surface'
import { toast } from 'sonner'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { buildAutomationRrule } from '../../../../shared/automation-schedule-occurrences'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { listAutomationsForTarget } from './automation-host-client'
import {
  dispatchAutomationReread,
  type AutomationDispatchResult
} from './automation-row-action-dispatch'
import { buildDraftPrecheck } from './automation-draft-model'
import { buildAutomationRunContextForRepo } from './automation-run-context'
import {
  buildAutomationLaunchOverridesCreateFields,
  buildAutomationLaunchOverridesUpdateFields
} from './fork-automation-launch-settings/automation-launch-overrides-save'
import { resolveAutomationSetupDecisionForSave } from './automation-setup-decision'
import {
  createAutomationOnDestination,
  moveAutomationToDestination,
  resolveAutomationEditDestination,
  saveExistingAutomation
} from './automation-orca-save-operations'
import type { AutomationSaveContext } from './automation-save-context'

/** Saves an Orca automation, including destination validation and host moves. */
export async function saveOrcaAutomation(
  context: AutomationSaveContext,
  time: { hour: number; minute: number; now: number; surface: 'chat' | 'terminal' }
): Promise<void> {
  const { store, local, setup, destination, destinationForm, pageRefresh, launchOverridesGate } =
    context
  const { repos, projectHostSetups } = store
  const {
    draft,
    editingAutomationId,
    editingRowKey,
    editingDestination,
    draftAtOpen,
    setEditorNotice,
    setEditorNoticeHost,
    moveCreationKeysRef
  } = local
  const {
    automationHostTarget,
    automationDispatchContext,
    invalidateWrittenHost,
    rowRecoveryHost,
    createDestination
  } = destination
  const { dialogRepos, editHostResolution, automationDialogTarget } = destinationForm

  // Fence the destination before hook probes/trust prompts or any other transaction side effect.
  const createCheck = editingAutomationId === null ? createDestination.check(draft.projectId) : null
  if (createCheck && !createCheck.ok) {
    setEditorNotice(createCheck.notice)
    return
  }

  let currentAutomation: Automation | null = null
  if (editingAutomationId !== null) {
    const reread = await dispatchAutomationReread(
      automationDispatchContext,
      { rowKey: editingRowKey ?? '', automationId: editingAutomationId },
      async () =>
        (await listAutomationsForTarget(automationHostTarget ?? { kind: 'local' })).find(
          (automation) => automation.id === editingAutomationId
        ) ?? null
    )
    if (!reread.ok) {
      setEditorNotice(reread.notice)
      return
    }
    currentAutomation = reread.value
    if (!currentAutomation) {
      throw new Error('This automation is no longer available. Refresh and try again.')
    }
  }

  const edited = (key: keyof typeof draft): boolean =>
    !draftAtOpen || draft[key] !== draftAtOpen[key]
  const targetEdited = !currentAutomation || local.targetEdited
  const scheduleEdited = (['preset', 'time', 'dayOfWeek', 'customSchedule'] as const).some(edited)
  const timezone = currentAutomation?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const rrule =
    draft.preset === 'custom'
      ? draft.customSchedule.trim()
      : buildAutomationRrule({
          preset: draft.preset,
          hour: time.hour,
          minute: time.minute,
          dayOfWeek: Number(draft.dayOfWeek)
        })
  const rawGrace = Number(draft.missedRunGraceMinutes)
  const missedRunGraceMinutes = Number.isFinite(rawGrace) ? Math.max(0, rawGrace) : 720
  const precheck = buildDraftPrecheck(draft)
  const launchOverridesCreateFields = buildAutomationLaunchOverridesCreateFields(
    draft.launchOverrides,
    launchOverridesGate
  )
  const launchOverridesUpdateFields = buildAutomationLaunchOverridesUpdateFields(
    draft.launchOverrides,
    launchOverridesGate
  )
  const reposForDraft = editingAutomationId !== null ? dialogRepos : repos
  const setupResolution =
    editingAutomationId !== null
      ? editHostResolution
      : createCheck
        ? { status: 'ready' as const, ...createCheck.destination }
        : null
  const selectedRepos = dialogRepos.filter((repo) => repo.id === draft.projectId)
  const setupHostId =
    setupResolution?.status === 'ready' && selectedRepos.length === 1
      ? getRepoExecutionHostId(selectedRepos[0])
      : undefined
  const setupProjectHostSetups = setupHostId
    ? projectHostSetups.filter(
        (candidate) => candidate.repoId !== draft.projectId || candidate.hostId === setupHostId
      )
    : projectHostSetups
  let setupDecision =
    !currentAutomation || edited('setupDecision')
      ? resolveAutomationSetupDecisionForSave({
          workspaceMode: draft.workspaceMode,
          repoId: draft.projectId,
          repos: dialogRepos,
          projectHostSetups: setupProjectHostSetups,
          yamlHooks:
            draft.workspaceMode === 'new_per_run'
              ? await setup.loadAutomationYamlHooksForRepo(draft.projectId, setupHostId)
              : null,
          draftSetupDecision: draft.setupDecision
        })
      : currentAutomation.setupDecision
  if (setupDecision === 'run' && ((targetEdited && !recordedContext) || edited('setupDecision'))) {
    const trustDecision = await ensureHooksConfirmed(
      useAppStore.getState(),
      draft.projectId,
      'setup',
      setupHostId
    )
    if (trustDecision === 'skip') {
      setupDecision = 'skip'
    }
  }

  const runContext = targetEdited
    ? (recordedContext ??
      buildAutomationRunContextForRepo({
        repoId: draft.projectId,
        repos: dialogRepos,
        projectHostSetups: setupProjectHostSetups
      }))
    : currentAutomation?.runContext
  if (targetEdited && !runContext) {
    toast.error(
      translate(
        'auto.components.automations.AutomationsPage.32534e7c9c',
        'Choose an available workspace before saving.'
      )
    )
    return
  }

  const surface =
    time.surface === 'chat' &&
    draft.surface === undefined &&
    automationChatSupport(
      useAppStore.getState(),
      draft,
      automationLaunchWorkspace(draft, setupResolution ?? undefined)
    ) === false
      ? 'terminal'
      : time.surface
  const launchSetup = automationDraftLaunchSetup(
    {
      extraAgentArgs: edited('extraAgentArgs')
        ? draft.extraAgentArgs
        : (currentAutomation?.extraAgentArgs ?? '')
    },
    edited('surface') ? surface : (currentAutomation?.surface ?? surface),
    currentAutomation
  )
  const updates: AutomationUpdateInput = {
    ...(edited('name') ? { name: draft.name } : {}),
    ...(edited('prompt') ? { prompt: draft.prompt } : {}),
    ...(edited('precheckCommand') || edited('precheckTimeoutSeconds') ? { precheck } : {}),
    ...(edited('agentId') ? { agentId: draft.agentId } : {}),
    ...(!currentAutomation || edited('surface') || edited('extraAgentArgs') ? launchSetup : {}),
    ...(targetEdited
      ? {
          runContext,
          projectId: draft.projectId,
          workspaceMode: draft.workspaceMode,
          workspaceId: draft.workspaceId
        }
      : {}),
    ...launchOverridesUpdateFields,
    runContext,
    projectId: draft.projectId,
    workspaceMode: draft.workspaceMode,
    workspaceId: draft.workspaceId,
    baseBranch: draft.baseBranch.trim() || null,
    setupDecision,
    reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
    timezone,
    missedRunGraceMinutes
  }
  if (!currentAutomation || (scheduleEdited && currentAutomation.rrule !== rrule)) {
    updates.rrule = rrule
    updates.dtstart = time.now
  }
  const createInput: AutomationCreateInput = {
    name: draft.name,
    prompt: draft.prompt,
    precheck,
    agentId: draft.agentId,
    ...(hasExtraAgentArgs(draft.extraAgentArgs) ? { extraAgentArgs: draft.extraAgentArgs } : {}),
    ...launchOverridesCreateFields,
    runContext,
    projectId: draft.projectId,
    workspaceMode: draft.workspaceMode,
    workspaceId: draft.workspaceId,
    baseBranch: draft.baseBranch.trim() || null,
    setupDecision,
    reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
    timezone,
    rrule: currentAutomation ? currentAutomation.rrule : rrule,
    dtstart: currentAutomation ? currentAutomation.dtstart : (updates.dtstart ?? time.now),
    missedRunGraceMinutes: currentAutomation
      ? currentAutomation.missedRunGraceMinutes
      : missedRunGraceMinutes,
    ...updates
  }

  const destinationResult = resolveAutomationEditDestination({
    currentAutomation,
    editingAutomationId,
    editingDestination,
    draft,
    targetEdited: local.targetEdited,
    rowKey: editingRowKey,
    automationDialogTarget,
    editHostEntries: destinationForm.editHostEntries,
    rowRecoveryHost
  })
  if (!destinationResult.ok) {
    setEditorNotice(destinationResult.notice)
    return
  }
  const { editDestination, moveTarget } = destinationResult

  let saved: AutomationDispatchResult<Automation>
  let originalRemoved = true
  if (moveTarget) {
    const moved = await moveAutomationToDestination(
      {
        automationDispatchContext,
        editingRowKey,
        automationDialogTarget,
        moveCreationKeysRef,
        invalidateWrittenHost
      },
      currentAutomation,
      moveTarget,
      {
        ...createInput,
        dtstart: updates.dtstart ?? currentAutomation?.dtstart ?? createInput.dtstart,
        enabled: currentAutomation?.enabled ?? true,
        sourceContext: currentAutomation?.sourceContext ?? null
      }
    )
    saved = moved.saved
    originalRemoved = moved.originalRemoved
  } else if (editingAutomationId !== null) {
    saved = await saveExistingAutomation(
      context,
      editingAutomationId,
      currentAutomation,
      updates,
      editDestination,
      automationHostTarget,
      editingRowKey
    )
  } else {
    saved = await createAutomationOnDestination(
      createCheck!.destination.authority,
      createInput,
      createCheck!.destination,
      invalidateWrittenHost
    )
  }
  if (!saved.ok) {
    setEditorNotice(saved.notice)
    setEditorNoticeHost(moveTarget?.entry ?? null)
    return
  }
  await completeAutomationSave(context, saved.value, moveTarget, originalRemoved)
}
