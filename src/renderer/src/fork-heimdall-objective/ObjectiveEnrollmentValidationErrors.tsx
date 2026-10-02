import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { ObjectiveEnrollmentError } from './objective-enrollment-model'

type ObjectiveEnrollmentValidationErrorsProps = {
  visible: boolean
  errors: ObjectiveEnrollmentError[]
}

function validationErrorCopy(error: ObjectiveEnrollmentError): string {
  switch (error.code) {
    case 'workspace-required':
      return translate('fork.heimdallObjective.validation.workspaceRequired', 'Choose a workspace.')
    case 'new-worktree-name-required':
      return translate(
        'fork.heimdallObjective.validation.newWorktreeNameRequired',
        'Enter a name for the new worktree.'
      )
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
    case 'max-concurrency-invalid':
      return translate(
        'fork.heimdallObjective.validation.maxConcurrency',
        'Max concurrency must be a whole number from 1 to 1,024.'
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
    case 'gate-name-invalid':
      return translate(
        'fork.heimdallObjective.validation.gateNameInvalid',
        'Check name {{name}} must be lowercase letters, digits, or hyphens, starting with a letter or digit, up to 40 characters.',
        { name: error.value ?? '' }
      )
    case 'gate-command-invalid':
      return translate(
        'fork.heimdallObjective.validation.gateCommandInvalid',
        'Enter a check command of up to 8,192 characters.'
      )
    case 'gate-timeout-invalid':
      return translate(
        'fork.heimdallObjective.validation.gateTimeoutInvalid',
        'Check timeout must be a whole number of seconds from 10 to 14,400.'
      )
    case 'gate-name-duplicate':
      return translate(
        'fork.heimdallObjective.validation.gateNameDuplicate',
        'Check names must be unique.'
      )
    case 'gates-too-many':
      return translate(
        'fork.heimdallObjective.validation.gatesTooMany',
        'Objectives support at most 8 declared checks.'
      )
    case 'gates-unsupported-host':
      return translate(
        'fork.heimdallObjective.validation.gatesUnsupportedHost',
        "Checks are unavailable on this host's Orca version. Remove all checks to continue."
      )
  }
}

export function ObjectiveEnrollmentValidationErrors({
  visible,
  errors
}: ObjectiveEnrollmentValidationErrorsProps): React.JSX.Element | null {
  if (!visible || errors.length === 0) {
    return null
  }

  return (
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
        {errors.map((error) => (
          <li key={`${error.code}:${error.value ?? ''}`}>{validationErrorCopy(error)}</li>
        ))}
      </ul>
    </div>
  )
}
