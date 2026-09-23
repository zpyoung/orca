import { translate } from '@/i18n/i18n'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import type { PlanLintCode } from '../../../shared/fork-heimdall-objective/plan-lint'

export function shortObjectiveIdentity(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

export function objectivePlanLintCodeLabel(code: PlanLintCode): string {
  switch (code) {
    case 'missing-territory':
      return translate(
        'fork.heimdallObjective.detail.lintCode.missingTerritory',
        'Missing territory'
      )
    case 'territory-outside-objective':
      return translate(
        'fork.heimdallObjective.detail.lintCode.territoryOutsideObjective',
        'Territory outside objective'
      )
    case 'test-only-node':
      return translate('fork.heimdallObjective.detail.lintCode.testOnlyNode', 'Test-only territory')
    case 'full-suite-check':
      return translate(
        'fork.heimdallObjective.detail.lintCode.fullSuiteCheck',
        'Full-suite command'
      )
    case 'unscoped-check':
      return translate('fork.heimdallObjective.detail.lintCode.unscopedCheck', 'Unscoped command')
    case 'non-relative-check':
      return translate(
        'fork.heimdallObjective.detail.lintCode.nonRelativeCheck',
        'Non-relative path'
      )
    case 'conflict-pair':
      return translate('fork.heimdallObjective.detail.lintCode.conflictPair', 'Territory conflict')
    case 'duplicates-gate':
      return translate('fork.heimdallObjective.detail.lintCode.duplicatesGate', 'Duplicates a gate')
    case 'no-gate-declared':
      return translate('fork.heimdallObjective.detail.lintCode.noGateDeclared', 'No gate declared')
    case 'missing-assumptions':
      return translate(
        'fork.heimdallObjective.detail.lintCode.missingAssumptions',
        'Missing assumptions'
      )
  }
}

export function objectivePlanReviewVerdictLabel(
  verdict: NonNullable<ObjectiveDetail['planReviews']>[number]['verdict']
): string {
  switch (verdict) {
    case 'approve':
      return translate('fork.heimdallObjective.detail.planReviewVerdict.approve', 'Approve')
    case 'revise':
      return translate('fork.heimdallObjective.detail.planReviewVerdict.revise', 'Revise')
    case 'escalate':
      return translate('fork.heimdallObjective.detail.planReviewVerdict.escalate', 'Escalate')
  }
}

export function objectiveAssumptionStatusLabel(status: 'verified' | 'unverified'): string {
  return status === 'verified'
    ? translate('fork.heimdallObjective.detail.assumptionStatus.verified', 'Verified')
    : translate('fork.heimdallObjective.detail.assumptionStatus.unverified', 'Unverified')
}

export function objectivePatchStatusLabel(
  status: NonNullable<ObjectiveDetail['pendingPatch']>['status']
): string {
  switch (status) {
    case 'pending':
      return translate('fork.heimdallObjective.detail.patchStatus.pending', 'Pending')
    case 'applied':
      return translate('fork.heimdallObjective.detail.patchStatus.applied', 'Applied')
    case 'rejected':
      return translate('fork.heimdallObjective.detail.patchStatus.rejected', 'Rejected')
  }
}

export function objectiveGateResultLabel(
  lastResult: NonNullable<ObjectiveDetail['gates']>[number]['lastResult']
): string {
  if (!lastResult) {
    return translate('fork.heimdallObjective.detail.gateResult.notRun', 'Not run')
  }
  if (lastResult.timedOut) {
    return translate('fork.heimdallObjective.detail.gateResult.timedOut', 'Timed out')
  }
  if (lastResult.pass) {
    return translate('fork.heimdallObjective.detail.gateResult.pass', 'Pass')
  }
  return translate('fork.heimdallObjective.detail.gateResult.failed', 'Failed (exit {{code}})', {
    code: lastResult.exitCode ?? '—'
  })
}
