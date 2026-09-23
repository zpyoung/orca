import { translate } from '@/i18n/i18n'
import { approvalScopeForAction } from '../../../shared/fork-heimdall/gate'
import { sameApprovalScope } from '../../../shared/fork-heimdall/ledger-queries'
import type { ApprovalScope, KernelAction } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import { ObjectiveActionSchema } from '../../../shared/fork-heimdall-objective/objective-actions'
import { hostedReviewSitterKernelActionLabel } from '../fork-hosted-review-sitter/hosted-review-sitter-format'

type ApprovalActionDetail = {
  label: string
  value: string
  mono?: boolean
}

type ApprovalActionPresentation = {
  title: string
  explanation: string
  details: readonly ApprovalActionDetail[]
}

function objectiveActionTitle(actionKind: string): string | null {
  switch (actionKind) {
    case 'dispatch-planner':
      return translate('fork.heimdall.approval.action.dispatchPlanner', 'Start planner')
    case 'ingest-plan':
      return translate('fork.heimdall.approval.action.ingestPlan', 'Read planner result')
    case 'activate-plan':
      return translate('fork.heimdall.approval.action.activatePlan', 'Activate plan')
    case 'dispatch-node':
      return translate('fork.heimdall.approval.action.dispatchNode', 'Start implementation task')
    case 'ingest-report':
      return translate('fork.heimdall.approval.action.ingestReport', 'Read implementation report')
    case 'run-check':
      return translate('fork.heimdall.approval.action.runCheck', 'Run acceptance check')
    case 'run-gate':
      return translate('fork.heimdall.approval.action.runGate', 'Run objective gate')
    case 'dispatch-reviewer':
      return translate('fork.heimdall.approval.action.dispatchReviewer', 'Start review')
    case 'dispatch-integrator':
      return translate(
        'fork.heimdall.approval.action.dispatchIntegrator',
        'Start integrator review'
      )
    case 'ingest-verdict':
      return translate('fork.heimdall.approval.action.ingestVerdict', 'Read review verdict')
    case 'record-landing':
      return translate('fork.heimdall.approval.action.recordLanding', 'Record completed work')
    case 'commit-local-branch':
      return translate('fork.heimdall.approval.action.commitLocalBranch', 'Commit local branch')
    case 'push-ref':
      return translate('fork.heimdall.approval.action.pushRef', 'Push branch')
    case 'open-hosted-review':
      return translate('fork.heimdall.approval.action.openHostedReview', 'Open hosted review')
    case 'apply-plan-patch':
      return translate('fork.heimdall.approval.action.applyPlanPatch', 'Apply plan repair')
    default:
      return null
  }
}

function approvalActionTitle(actionKind: string): string {
  return objectiveActionTitle(actionKind) ?? hostedReviewSitterKernelActionLabel(actionKind)
}

function genericExplanation(actionKind: string): string {
  switch (actionKind) {
    case 'dispatch-planner':
      return translate(
        'fork.heimdall.approval.explanation.dispatchPlanner',
        'Start the planner for this objective.'
      )
    case 'ingest-plan':
      return translate(
        'fork.heimdall.approval.explanation.ingestPlan',
        'Read the planner result into the objective plan.'
      )
    case 'activate-plan':
      return translate(
        'fork.heimdall.approval.explanation.activatePlan',
        'Make the prepared objective plan active.'
      )
    case 'dispatch-node':
      return translate(
        'fork.heimdall.approval.explanation.dispatchNode',
        'Start an implementation worker for an objective task.'
      )
    case 'ingest-report':
      return translate(
        'fork.heimdall.approval.explanation.ingestReport',
        'Read an implementation worker report into the objective state.'
      )
    case 'run-check':
      return translate(
        'fork.heimdall.approval.explanation.runCheck',
        'Run an acceptance command for the objective.'
      )
    case 'run-gate':
      return translate(
        'fork.heimdall.approval.explanation.runGate',
        'Run a whole-tree command on the integrated branch before review and landing.'
      )
    case 'dispatch-reviewer':
      return translate(
        'fork.heimdall.approval.explanation.dispatchReviewer',
        'Start an independent review of the objective work.'
      )
    case 'dispatch-integrator':
      return translate(
        'fork.heimdall.approval.explanation.dispatchIntegrator',
        'Start the final integration review of the objective work.'
      )
    case 'ingest-verdict':
      return translate(
        'fork.heimdall.approval.explanation.ingestVerdict',
        'Read a review verdict into the objective state.'
      )
    case 'record-landing':
      return translate(
        'fork.heimdall.approval.explanation.recordLanding',
        'Record the completed objective work as landed on disk.'
      )
    case 'commit-local-branch':
      return translate(
        'fork.heimdall.approval.explanation.commitLocalBranch',
        'Commit the completed objective work to its local branch.'
      )
    case 'push-ref':
      return translate(
        'fork.heimdall.approval.explanation.pushRef',
        'Push the objective branch to its remote.'
      )
    case 'open-hosted-review':
      return translate(
        'fork.heimdall.approval.explanation.openHostedReview',
        'Open a hosted review for the objective branch.'
      )
    case 'apply-plan-patch':
      return translate(
        'fork.heimdall.approval.explanation.applyPlanPatch',
        'Apply a planner repair patch to the approved objective plan.'
      )
    case 'rerun-check':
      return translate(
        'fork.heimdall.approval.explanation.rerunCheck',
        'Request another run of the failed hosted check.'
      )
    case 'prepare-fix':
      return translate(
        'fork.heimdall.approval.explanation.prepareFix',
        'Start a worker to prepare a fix for the failed hosted check.'
      )
    case 'publish-fix':
      return translate(
        'fork.heimdall.approval.explanation.publishFix',
        'Publish the prepared check fix to the hosted review branch.'
      )
    case 'prepare-conflict-resolution':
      return translate(
        'fork.heimdall.approval.explanation.prepareConflictResolution',
        'Start a worker to prepare a merge-conflict resolution.'
      )
    case 'publish-conflict-resolution':
      return translate(
        'fork.heimdall.approval.explanation.publishConflictResolution',
        'Publish the prepared conflict resolution to the hosted review branch.'
      )
    case 'update-branch':
      return translate(
        'fork.heimdall.approval.explanation.updateBranch',
        'Update the hosted review branch from its base branch.'
      )
    case 'merge':
      return translate('fork.heimdall.approval.explanation.merge', 'Merge the hosted review.')
    case 'enqueue':
      return translate(
        'fork.heimdall.approval.explanation.enqueue',
        'Enter the hosted review in its merge queue.'
      )
    default:
      return translate(
        'fork.heimdall.approval.explanation.unknown',
        'Approve this exact requested action.'
      )
  }
}

export function latestApprovalAction(
  traces: readonly WatcherTickTrace[],
  scope: ApprovalScope
): KernelAction | null {
  let latest: { seq: number; action: KernelAction } | null = null
  for (const trace of traces) {
    const action = trace.decision?.action
    if (
      action &&
      sameApprovalScope(approvalScopeForAction(action), scope) &&
      (latest === null || trace.seq > latest.seq)
    ) {
      latest = { seq: trace.seq, action }
    }
  }
  return latest?.action ?? null
}

function detail(label: string, value: string, mono = false): ApprovalActionDetail {
  return { label, value, ...(mono ? { mono: true } : {}) }
}

function stringProperty(action: KernelAction, key: string): string | null {
  const value = action[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberProperty(action: KernelAction, key: string): string | null {
  const value = action[key]
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function actionDetails(action: KernelAction): readonly ApprovalActionDetail[] {
  const objectiveAction = ObjectiveActionSchema.safeParse(action)
  const hostedReviewTitle = hostedReviewSitterKernelActionLabel(action.kind)
  if (!objectiveAction.success && hostedReviewTitle === action.kind) {
    return []
  }

  const details: ApprovalActionDetail[] = []
  const add = (label: string, value: string | null, mono = false): void => {
    if (value) {
      details.push(detail(label, value, mono))
    }
  }

  add(
    translate('fork.heimdall.approval.detail.task', 'Task'),
    stringProperty(action, 'taskKey'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.revision', 'Revision'),
    numberProperty(action, 'revisionNumber') ?? stringProperty(action, 'revisionId'),
    stringProperty(action, 'revisionId') !== null
  )
  add(
    translate('fork.heimdall.approval.detail.criterion', 'Criterion'),
    stringProperty(action, 'criterionId'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.command', 'Command'),
    stringProperty(action, 'command'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.branch', 'Branch'),
    stringProperty(action, 'branch'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.remote', 'Remote'),
    stringProperty(action, 'remote'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.baseBranch', 'Base branch'),
    stringProperty(action, 'base'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.provider', 'Provider'),
    stringProperty(action, 'provider')
  )
  add(
    translate('fork.heimdall.approval.detail.reviewRole', 'Review role'),
    stringProperty(action, 'role')
  )
  add(
    translate('fork.heimdall.approval.detail.commit', 'Commit'),
    stringProperty(action, 'commitSha'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.check', 'Check'),
    stringProperty(action, 'checkKey'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.baseCommit', 'Base commit'),
    stringProperty(action, 'baseSha'),
    true
  )
  add(
    translate('fork.heimdall.approval.detail.mergeMethod', 'Merge method'),
    stringProperty(action, 'mergeMethod')
  )
  add(
    translate('fork.heimdall.approval.detail.updateMethod', 'Update method'),
    stringProperty(action, 'mode')
  )
  add(
    translate('fork.heimdall.approval.detail.review', 'Review'),
    stringProperty(action, 'reviewUrl'),
    true
  )
  return details
}

export function approvalActionPresentation(
  scope: ApprovalScope,
  action: KernelAction | null
): ApprovalActionPresentation {
  return {
    title: approvalActionTitle(scope.actionKind),
    explanation: genericExplanation(scope.actionKind),
    details: action ? actionDetails(action) : []
  }
}
