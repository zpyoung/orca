import { useEffect, useMemo, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
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
import { ObjectiveEnrollmentFields } from './ObjectiveEnrollmentFields'
import {
  OBJECTIVE_ROLES,
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft,
  type ObjectiveLandingBarAvailability,
  type ObjectiveEnrollmentError
} from './objective-enrollment-model'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import { describeObjectiveError, getObjectiveHeimdallApi } from './objective-heimdall-api'
import { buildObjectiveWorkspaceOptions } from './objective-workspace-options'

const DEFAULT_ACTIVE_BUDGET_HOURS = 4
const DEFAULT_TURN_BUDGET = '40'

function newDraft(): ObjectiveEnrollmentDraft {
  return {
    objectiveText: '',
    existingPlanText: '',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
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
    activeBudgetHours: DEFAULT_ACTIVE_BUDGET_HOURS,
    turns: DEFAULT_TURN_BUDGET,
    availableAgentIds: []
  }
}

function validationErrorCopy(error: ObjectiveEnrollmentError): string {
  switch (error.code) {
    case 'workspace-required':
      return translate('fork.heimdallObjective.validation.workspaceRequired', 'Choose a workspace.')
    case 'objective-required':
      return translate('fork.heimdallObjective.validation.objectiveRequired', 'Enter an objective.')
    case 'objective-too-long':
      return translate(
        'fork.heimdallObjective.validation.objectiveTooLong',
        'The objective must be 16,384 characters or fewer.'
      )
    case 'existing-plan-too-long':
      return translate(
        'fork.heimdallObjective.validation.existingPlanTooLong',
        'The existing plan must be 65,536 characters or fewer.'
      )
    case 'landing-bar-requires-git':
      return translate(
        'fork.heimdallObjective.validation.landingBarRequiresGit',
        'Folder workspaces support only the files-on-disk landing bar.'
      )
    case 'landing-bar-requires-worktree':
      return translate(
        'fork.heimdallObjective.enrollment.landingBarRequiresWorktree',
        'Hosted-review and merged landing bars require a git worktree.'
      )
    case 'max-concurrency-unsupported':
      return translate(
        'fork.heimdallObjective.validation.maxConcurrency',
        'This release supports exactly one objective worker at a time.'
      )
    case 'territory-too-many':
      return translate(
        'fork.heimdallObjective.validation.territoryTooMany',
        'Write territory supports at most 64 globs.'
      )
    case 'territory-duplicate':
      return translate(
        'fork.heimdallObjective.validation.territoryDuplicate',
        'Write-territory globs must be unique.'
      )
    case 'territory-invalid':
      return translate(
        'fork.heimdallObjective.validation.territoryInvalid',
        'Invalid write-territory glob: {{glob}}',
        { glob: error.value ?? '' }
      )
    case 'capability-set-invalid':
      return translate(
        'fork.heimdallObjective.validation.capabilitiesInvalid',
        'All five objective capabilities must be configured.'
      )
    case 'plan-off-requires-approved-plan':
      return translate(
        'fork.heimdallObjective.validation.planOffRequiresApprovedPlan',
        'Set Plan to Gated or On. This form cannot verify a reusable approved plan.'
      )
    case 'role-agent-unknown':
      return translate(
        'fork.heimdallObjective.validation.roleAgentUnknown',
        'Agent {{agent}} is not available on the selected workspace host.',
        { agent: error.value ?? '' }
      )
    case 'active-budget-invalid':
      return translate(
        'fork.heimdallObjective.validation.activeBudgetInvalid',
        'Choose a positive active-work budget.'
      )
    case 'turn-budget-invalid':
      return translate(
        'fork.heimdallObjective.validation.turnBudgetInvalid',
        'Worker turns must be a whole number of zero or more.'
      )
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
  return message
}

export type ObjectiveEnrollmentSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ObjectiveEnrollmentSheet({
  open,
  onOpenChange
}: ObjectiveEnrollmentSheetProps): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const detectedAgentIds = useAppStore((state) => state.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((state) => state.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((state) => state.runtimeDetectedAgentIds)
  const settings = useAppStore((state) => state.settings)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const workspaces = useMemo(
    () =>
      buildObjectiveWorkspaceOptions({
        repos,
        worktreesByRepo,
        runtimeEnvironments,
        detectedAgentIds,
        remoteDetectedAgentIds,
        runtimeDetectedAgentIds,
        settings
      }),
    [
      detectedAgentIds,
      remoteDetectedAgentIds,
      repos,
      runtimeDetectedAgentIds,
      runtimeEnvironments,
      settings,
      worktreesByRepo
    ]
  )
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState('')
  const [draft, setDraft] = useState<ObjectiveEnrollmentDraft>(newDraft)
  const [showValidation, setShowValidation] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const selectedWorkspace = workspaces.find((workspace) => workspace.key === selectedWorkspaceKey)
  const landingAvailability: ObjectiveLandingBarAvailability = {
    workspaceKind: selectedWorkspace?.workspaceKind ?? null,
    worktreeId: selectedWorkspace?.worktreeId ?? null
  }
  const validationErrors = validateObjectiveEnrollmentDraft(draft, landingAvailability)
  const planOffBlocked = draft.capabilities.plan === 'off'

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
      (selectedWorkspace.worktreeId === null && highLandingBar)
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
          roleAgents: Object.fromEntries(
            OBJECTIVE_ROLES.map((role) => [
              role,
              availableAgentIds.includes(current.roleAgents[role]) ? current.roleAgents[role] : ''
            ])
          ) as ObjectiveEnrollmentDraft['roleAgents'],
          availableAgentIds
        }
      })
    }
  }, [draft, selectedWorkspace, selectedWorkspaceKey])

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
          : workspace.worktreeId === null && highLandingBar
            ? 'pushed-ref'
            : current.landingBar
      return {
        ...current,
        workspaceKind: workspace?.workspaceKind ?? null,
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
    if (!selectedWorkspace || validationErrors.length > 0) {
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

    const submission = buildObjectiveEnrollmentSubmission(draft, selectedWorkspace)

    setSubmitting(true)
    try {
      await api.enroll(submission.input, submission.owner)
      await hydrateFleet()
      setDraft(newDraft())
      setSelectedWorkspaceKey('')
      setShowValidation(false)
      onOpenChange(false)
    } catch (error) {
      setServerError(enrollmentErrorCopy(error))
    } finally {
      setSubmitting(false)
    }
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
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>
            {translate('fork.heimdallObjective.enrollment.title', 'New objective')}
          </SheetTitle>
          <SheetDescription>
            {translate(
              'fork.heimdallObjective.enrollment.description',
              'Define the contract Heimdall will plan, execute, review, and land.'
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 scrollbar-sleek">
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
          {showValidation && validationErrors.length > 0 ? (
            <div
              className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="size-3.5" aria-hidden />
                {translate(
                  'fork.heimdallObjective.enrollment.validationTitle',
                  'Fix the contract before starting'
                )}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {validationErrors.map((error) => (
                  <li key={`${error.code}:${error.value ?? ''}`}>{validationErrorCopy(error)}</li>
                ))}
              </ul>
            </div>
          ) : null}
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
          <Button
            type="button"
            disabled={submitting || planOffBlocked}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {translate('fork.heimdallObjective.enrollment.submit', 'Start objective')}
          </Button>
        </footer>
      </SheetContent>
    </Sheet>
  )
}
