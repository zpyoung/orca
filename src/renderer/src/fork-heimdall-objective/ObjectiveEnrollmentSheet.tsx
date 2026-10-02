import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { objectiveCapabilityModes } from '../../../shared/fork-heimdall-objective/contract-types'
import { defaultWatcherOwnerDraft } from '../fork-heimdall/watcher-owner-draft'
import { ObjectiveEnrollmentFields } from './ObjectiveEnrollmentFields'
import { ObjectiveEnrollmentValidationErrors } from './ObjectiveEnrollmentValidationErrors'
import {
  OBJECTIVE_ROLES,
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft,
  type ObjectiveLandingBarAvailability
} from './objective-enrollment-model'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import { describeObjectiveError, getObjectiveHeimdallApi } from './objective-heimdall-api'
import { buildObjectiveWorkspaceOptions } from './objective-workspace-options'
import type { PipelineObjectiveNode } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { routeEnrollmentKind } from '../../../shared/fork-heimdall-pipeline/enrollment-routing'
import { PipelineRunForm } from '../fork-heimdall-pipeline/PipelineRunForm'
import {
  PipelinePicker,
  type LoadedPipelineSelection
} from '../fork-heimdall-pipeline/PipelinePicker'
import { startPipelineRun } from '../fork-heimdall-pipeline/pipeline-run-start'

const DEFAULT_ACTIVE_BUDGET_HOURS = 4
const DEFAULT_TURN_BUDGET = '40'

function newDraft(): ObjectiveEnrollmentDraft {
  return {
    objectiveText: '',
    newWorktreeName: '',
    newWorktreeNameEdited: false,
    newWorktreeBaseBranch: undefined,
    existingPlanText: '',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 3,
    lanesEnabled: true,
    workspaceKind: null,
    writeTerritoryText: '',
    capabilities: objectiveCapabilityModes('files-on-disk'),
    roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
    sitterOverrides: {
      updateBranch: 'inherit',
      resolveConflicts: 'inherit',
      fixChecks: 'inherit',
      merge: 'inherit'
    },
    gates: [],
    activeBudgetHours: DEFAULT_ACTIVE_BUDGET_HOURS,
    turns: DEFAULT_TURN_BUDGET,
    availableAgentIds: [],
    owner: defaultWatcherOwnerDraft()
  }
}
function draftForObjectiveNode(
  draft: ObjectiveEnrollmentDraft,
  node: PipelineObjectiveNode
): ObjectiveEnrollmentDraft {
  return {
    ...draft,
    existingPlanText: '',
    tier: node.tier,
    landingBar: node.landingBar,
    maxConcurrency: node.maxConcurrency ?? 3,
    lanesEnabled: node.lanesEnabled ?? true,
    writeTerritoryText: '**',
    capabilities: objectiveCapabilityModes(node.landingBar),
    roleAgents: {
      planner: node.roleAgents?.planner ?? '',
      implementer: node.roleAgents?.implementer ?? '',
      reviewer: node.roleAgents?.reviewer ?? '',
      integrator: node.roleAgents?.integrator ?? ''
    },
    sitterOverrides: {
      updateBranch: 'inherit',
      resolveConflicts: 'inherit',
      fixChecks: 'inherit',
      merge: 'inherit'
    },
    gates: (node.checks ?? []).map((check) => ({
      rowKey: check.name,
      name: check.name,
      command: check.command,
      timeoutSecondsText: String(check.timeoutSeconds)
    }))
  }
}

function enrollmentErrorCopy(error: unknown): string {
  const message = describeObjectiveError(error)
  const reason = message.trim()
  if (reason.includes('landing-bar-requires-git')) {
    return translate(
      'fork.heimdallObjective.enrollment.landingBarRequiresGit',
      'Folder workspaces support only the files-on-disk landing bar.'
    )
  }
  if (reason.includes('landing-bar-requires-worktree')) {
    return translate(
      'fork.heimdallObjective.enrollment.landingBarRequiresWorktree',
      'Hosted-review and merged landing bars require a git worktree.'
    )
  }
  if (reason.includes('landing-bar-requires-supported-forge')) {
    return translate(
      'fork.heimdallObjective.enrollment.landingBarRequiresSupportedForge',
      'Hosted-review and merged landing bars require a GitHub or GitLab repository.'
    )
  }
  if (reason.includes('plan-off-requires-approved-plan')) {
    return translate(
      'fork.heimdallObjective.enrollment.planOffRequiresApprovedPlan',
      'Plan can be Off only when this same objective already has a usable approved plan. Set Plan to Gated or On.'
    )
  }
  if (reason.includes('owner-not-supported')) {
    return translate(
      'fork.heimdallObjective.enrollment.ownerNotSupported',
      'The remote host does not support enrolling a watcher with an owner yet. Update it, or leave the owning agent off and try again.'
    )
  }
  return message
}

export type ObjectiveEnrollmentSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPipelineRef?: string
  initialWorktreeId?: string
}

export function ObjectiveEnrollmentSheet({
  open,
  onOpenChange,
  initialPipelineRef,
  initialWorktreeId
}: ObjectiveEnrollmentSheetProps): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const detectedAgentIds = useAppStore((state) => state.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((state) => state.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((state) => state.runtimeDetectedAgentIds)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const settings = useAppStore((state) => state.settings)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const fetchAllWorktrees = useAppStore((state) => state.fetchAllWorktrees)
  const workspaces = useMemo(
    () =>
      buildObjectiveWorkspaceOptions({
        repos,
        worktreesByRepo,
        folderWorkspaces,
        projectGroups,
        runtimeEnvironments,
        detectedAgentIds,
        remoteDetectedAgentIds,
        runtimeDetectedAgentIds,
        runtimeStatusByEnvironmentId,
        settings
      }),
    [
      detectedAgentIds,
      folderWorkspaces,
      projectGroups,
      remoteDetectedAgentIds,
      repos,
      runtimeDetectedAgentIds,
      runtimeStatusByEnvironmentId,
      runtimeEnvironments,
      settings,
      worktreesByRepo
    ]
  )
  useEffect(() => {
    if (open) {
      void fetchAllWorktrees()
    }
  }, [fetchAllWorktrees, open])
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState('')
  const [draft, setDraft] = useState<ObjectiveEnrollmentDraft>(newDraft)
  const [showValidation, setShowValidation] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const [selectedPipeline, setSelectedPipeline] = useState<LoadedPipelineSelection | null>(null)
  const updatePipelineSelection = useCallback((selection: LoadedPipelineSelection | null) => {
    setSelectedPipeline(selection)
  }, [])
  useEffect(() => {
    const worktreeId = initialWorktreeId ?? activeWorktreeId
    if (!open || !worktreeId || selectedWorkspaceKey) {
      return
    }
    const initialWorkspace = workspaces.find((workspace) => workspace.worktreeId === worktreeId)
    if (initialWorkspace) {
      setSelectedWorkspaceKey(initialWorkspace.key)
    }
  }, [activeWorktreeId, initialWorktreeId, open, selectedWorkspaceKey, workspaces])
  const selectedWorkspace = workspaces.find((workspace) => workspace.key === selectedWorkspaceKey)
  const landingAvailability: ObjectiveLandingBarAvailability = {
    workspaceKind: selectedWorkspace?.workspaceKind ?? null,
    worktreeId: selectedWorkspace?.worktreeId ?? null,
    createsWorktree: selectedWorkspace?.createsWorktree,
    parallelUnsupported: selectedWorkspace?.parallelExecutionSupported === false
  }
  const validationErrors = validateObjectiveEnrollmentDraft(draft, landingAvailability)
  const planOffBlocked = draft.capabilities.plan === 'off'
  const selectedRoute = selectedPipeline?.document
    ? routeEnrollmentKind(selectedPipeline.document)
    : null
  const objectiveSelected = selectedRoute === 'objective'
  const selectionValid = selectedPipeline?.valid === true

  useEffect(() => {
    if (!selectedWorkspace) {
      if (selectedWorkspaceKey) {
        setSelectedWorkspaceKey('')
        setDraft((current) => ({
          ...current,
          workspaceKind: null,
          landingBar: 'files-on-disk',
          capabilities: { ...current.capabilities, land: 'on' },
          roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
          availableAgentIds: []
        }))
      }
      return
    }
    const availableAgentIds = selectedWorkspace.availableAgentIds
    const unavailableRole = OBJECTIVE_ROLES.some((role) => {
      const agentId = draft.roleAgents[role]
      return agentId && !availableAgentIds.includes(agentId)
    })
    const highLandingBar = draft.landingBar === 'hosted-review' || draft.landingBar === 'merged'
    const resetLandingBar =
      (selectedWorkspace.workspaceKind === 'folder' && draft.landingBar !== 'files-on-disk') ||
      (selectedWorkspace.worktreeId === null &&
        !selectedWorkspace.createsWorktree &&
        highLandingBar)
    if (
      draft.workspaceKind !== selectedWorkspace.workspaceKind ||
      unavailableRole ||
      resetLandingBar ||
      draft.availableAgentIds.join('\0') !== availableAgentIds.join('\0')
    ) {
      setDraft((current) => {
        const landingBar =
          selectedWorkspace.workspaceKind === 'folder'
            ? 'files-on-disk'
            : selectedWorkspace.worktreeId === null &&
                !selectedWorkspace.createsWorktree &&
                (current.landingBar === 'hosted-review' || current.landingBar === 'merged')
              ? 'pushed-ref'
              : current.landingBar
        return {
          ...current,
          workspaceKind: selectedWorkspace.workspaceKind,
          landingBar,
          capabilities:
            landingBar === 'files-on-disk'
              ? { ...current.capabilities, land: 'on' }
              : current.capabilities,
          roleAgents: OBJECTIVE_ROLES.reduce<ObjectiveEnrollmentDraft['roleAgents']>(
            (roleAgents, role) => {
              roleAgents[role] = availableAgentIds.includes(current.roleAgents[role])
                ? current.roleAgents[role]
                : ''
              return roleAgents
            },
            { ...current.roleAgents }
          ),
          availableAgentIds
        }
      })
    }
  }, [draft, selectedWorkspace, selectedWorkspaceKey])
  useEffect(() => {
    const document = selectedPipeline?.document
    const node = document?.nodes[0]
    if (!document || routeEnrollmentKind(document) !== 'objective' || node?.type !== 'objective') {
      return
    }
    setDraft((current) => draftForObjectiveNode(current, node))
  }, [selectedPipeline])

  const selectWorkspace = (key: string): void => {
    const workspace = workspaces.find((candidate) => candidate.key === key)
    setSelectedWorkspaceKey(key)
    setServerError(null)
    setDraft((current) => {
      const highLandingBar =
        current.landingBar === 'hosted-review' || current.landingBar === 'merged'
      const landingBar =
        !workspace || workspace.workspaceKind === 'folder'
          ? 'files-on-disk'
          : workspace.worktreeId === null && !workspace.createsWorktree && highLandingBar
            ? 'pushed-ref'
            : current.landingBar
      return {
        ...current,
        workspaceKind: workspace?.workspaceKind ?? null,
        newWorktreeBaseBranch:
          workspace?.repoId === selectedWorkspace?.repoId
            ? current.newWorktreeBaseBranch
            : undefined,
        landingBar,
        capabilities:
          landingBar === 'files-on-disk'
            ? { ...current.capabilities, land: 'on' }
            : current.capabilities,
        roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
        availableAgentIds: workspace?.availableAgentIds ?? []
      }
    })
  }

  const submit = async (): Promise<void> => {
    setShowValidation(true)
    setServerError(null)
    const api = getObjectiveHeimdallApi()
    if (!api) {
      setServerError(
        translate(
          'fork.heimdallObjective.enrollment.serviceUnavailable',
          'Heimdall enrollment is not available in this client.'
        )
      )
      return
    }
    if (!selectedWorkspace || validationErrors.length > 0 || !selectedPipeline || !selectionValid) {
      return
    }
    if (selectedWorkspace.ownerUnavailable) {
      setServerError(
        translate(
          'fork.heimdallObjective.enrollment.ownerUnavailable',
          'The workspace owner is unavailable; no enrollment was sent.'
        )
      )
      return
    }
    if (selectedRoute !== 'objective') {
      setServerError(
        translate(
          'fork.heimdallPipeline.sheet.objectiveRequired',
          'Choose an Objective pipeline to use these fields.'
        )
      )
      return
    }

    const submission = buildObjectiveEnrollmentSubmission(draft, selectedWorkspace)
    setSubmitting(true)
    try {
      await startPipelineRun({
        ref: selectedPipeline.ref,
        worktree: selectedWorkspace,
        grants: {},
        runInputs: {},
        budget: submission.input.budget,
        owner: submission.owner,
        objectiveSubmission: submission
      })
      if (selectedWorkspace.createsWorktree) {
        void fetchAllWorktrees()
      }
      await hydrateFleet()
      setDraft(newDraft())
      setSelectedWorkspaceKey('')
      setSelectedPipeline(null)
      setShowValidation(false)
      onOpenChange(false)
    } catch (error) {
      setServerError(enrollmentErrorCopy(error))
    } finally {
      setSubmitting(false)
    }
  }

  const runStarted = (): void => {
    void hydrateFleet()
    setDraft(newDraft())
    setSelectedWorkspaceKey('')
    setSelectedPipeline(null)
    setShowValidation(false)
    onOpenChange(false)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setServerError(null)
          setShowValidation(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <SheetContent className="w-[min(620px,calc(100vw-1rem))] sm:max-w-[620px]">
        <div className="border-b border-border">
          <SheetHeader className="mr-12">
            <SheetTitle>{translate('fork.heimdallPipeline.sheet.title', 'New run')}</SheetTitle>
            <SheetDescription>
              {translate(
                'fork.heimdallPipeline.sheet.description',
                'Choose a pipeline, workspace, inputs, and capabilities for this run.'
              )}
            </SheetDescription>
          </SheetHeader>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 scrollbar-sleek">
          <PipelinePicker
            key={`${open ? 'open' : 'closed'}:${initialPipelineRef ?? ''}`}
            workspace={selectedWorkspace ?? null}
            worktreeId={selectedWorkspace?.worktreeId ?? activeWorktreeId}
            initialRef={initialPipelineRef}
            onSelectionChange={updatePipelineSelection}
          />
          {objectiveSelected && selectedPipeline?.document ? (
            <div className="mt-5">
              <ObjectiveEnrollmentFields
                draft={draft}
                selectedWorkspaceKey={selectedWorkspaceKey}
                workspaces={workspaces}
                landingAvailability={landingAvailability}
                agents={getAgentCatalog()}
                disabled={submitting}
                onWorkspaceChange={selectWorkspace}
                onDraftChange={setDraft}
              />
            </div>
          ) : selectedPipeline?.document ? (
            <div className="mt-5">
              <PipelineRunForm
                key={selectedPipeline.ref}
                pipelineRef={selectedPipeline.ref}
                document={selectedPipeline.document}
                validationErrors={selectedPipeline.validationErrors}
                valid={selectedPipeline.valid}
                workspaces={workspaces}
                selectedWorkspaceKey={selectedWorkspaceKey}
                onWorkspaceChange={selectWorkspace}
                onStarted={runStarted}
              />
            </div>
          ) : null}
          <ObjectiveEnrollmentValidationErrors
            visible={showValidation && objectiveSelected}
            errors={validationErrors}
          />
          {serverError ? (
            <p className="mt-5 text-xs text-destructive" role="alert">
              {serverError}
            </p>
          ) : null}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
          <SheetClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              {translate('fork.heimdallObjective.enrollment.cancel', 'Cancel')}
            </Button>
          </SheetClose>
          {objectiveSelected ? (
            <Button
              type="button"
              disabled={submitting || planOffBlocked || !selectedPipeline || !selectionValid}
              onClick={() => void submit()}
            >
              {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {translate('fork.heimdallPipeline.runForm.start', 'Start run')}
            </Button>
          ) : null}
        </footer>
      </SheetContent>
    </Sheet>
  )
}
