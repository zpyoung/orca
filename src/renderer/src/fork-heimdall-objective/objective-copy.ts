import { translate } from '@/i18n/i18n'
import type {
  ObjectiveCapabilityKey,
  ObjectiveLandingBar,
  ObjectiveRole,
  ObjectiveSitterOverrides,
  ObjectiveTier,
  ObjectiveWorkspaceKind
} from '../../../shared/fork-heimdall-objective/contract-types'
import type {
  ObjectiveNodeState,
  ObjectiveReviewRole,
  ObjectiveRevisionStatus,
  ObjectiveVerdict
} from '../../../shared/fork-heimdall-objective/detail-types'
import type { CapabilityMode } from '../../../shared/fork-heimdall/watcher-types'

export function objectiveTierLabel(value: ObjectiveTier): string {
  switch (value) {
    case 'express':
      return translate('fork.heimdallObjective.value.tier.express', 'Express')
    case 'standard':
      return translate('fork.heimdallObjective.value.tier.standard', 'Standard')
    case 'full':
      return translate('fork.heimdallObjective.value.tier.full', 'Full')
  }
}

export function objectiveLandingBarLabel(value: ObjectiveLandingBar): string {
  switch (value) {
    case 'files-on-disk':
      return translate('fork.heimdallObjective.value.bar.filesOnDisk', 'Files on disk')
    case 'committed-local-branch':
      return translate(
        'fork.heimdallObjective.value.bar.committedLocalBranch',
        'Committed local branch'
      )
    case 'pushed-ref':
      return translate('fork.heimdallObjective.value.bar.pushedRef', 'Pushed ref')
    case 'hosted-review':
      return translate('fork.heimdallObjective.value.bar.hostedReview', 'Hosted review')
    case 'merged':
      return translate('fork.heimdallObjective.value.bar.merged', 'Merged')
  }
}

export function objectiveCapabilityModeLabel(value: CapabilityMode): string {
  switch (value) {
    case 'off':
      return translate('fork.heimdallObjective.value.capabilityMode.off', 'Off')
    case 'gated':
      return translate('fork.heimdallObjective.value.capabilityMode.gated', 'Approval required')
    case 'on':
      return translate('fork.heimdallObjective.value.capabilityMode.on', 'On')
  }
}

export function objectiveCapabilityLabel(value: ObjectiveCapabilityKey): string {
  switch (value) {
    case 'plan':
      return translate('fork.heimdallObjective.value.capability.plan', 'Plan')
    case 'implement':
      return translate('fork.heimdallObjective.value.capability.implement', 'Implement')
    case 'review':
      return translate('fork.heimdallObjective.value.capability.review', 'Review')
    case 'check':
      return translate('fork.heimdallObjective.value.capability.check', 'Run checks')
    case 'land':
      return translate('fork.heimdallObjective.value.capability.land', 'Land')
  }
}

export function objectiveRoleLabel(value: ObjectiveRole): string {
  switch (value) {
    case 'planner':
      return translate('fork.heimdallObjective.value.role.planner', 'Planner')
    case 'implementer':
      return translate('fork.heimdallObjective.value.role.implementer', 'Implementer')
    case 'reviewer':
      return translate('fork.heimdallObjective.value.role.reviewer', 'Reviewer')
    case 'integrator':
      return translate('fork.heimdallObjective.value.role.integrator', 'Integrator')
  }
}

export function objectiveSitterCapabilityLabel(value: keyof ObjectiveSitterOverrides): string {
  switch (value) {
    case 'updateBranch':
      return translate('fork.heimdallObjective.value.sitter.updateBranch', 'Update branch')
    case 'resolveConflicts':
      return translate('fork.heimdallObjective.value.sitter.resolveConflicts', 'Resolve conflicts')
    case 'fixChecks':
      return translate('fork.heimdallObjective.value.sitter.fixChecks', 'Fix checks')
    case 'merge':
      return translate('fork.heimdallObjective.value.sitter.merge', 'Merge')
  }
}

export function objectiveWorkspaceKindLabel(value: ObjectiveWorkspaceKind): string {
  return value === 'folder'
    ? translate('fork.heimdallObjective.value.workspace.folder', 'Folder')
    : translate('fork.heimdallObjective.value.workspace.git', 'Git')
}

export function objectiveNodeStateLabel(value: ObjectiveNodeState): string {
  switch (value) {
    case 'pending':
      return translate('fork.heimdallObjective.value.node.pending', 'Pending')
    case 'blocked-by-deps':
      return translate('fork.heimdallObjective.value.node.blockedByDeps', 'Blocked by dependencies')
    case 'awaiting-approval':
      return translate('fork.heimdallObjective.value.node.awaitingApproval', 'Awaiting approval')
    case 'dispatched':
      return translate('fork.heimdallObjective.value.node.dispatched', 'Dispatched')
    case 'succeeded':
      return translate('fork.heimdallObjective.value.node.succeeded', 'Succeeded')
    case 'failed':
      return translate('fork.heimdallObjective.value.node.failed', 'Failed')
    case 'replanned':
      return translate('fork.heimdallObjective.value.node.replanned', 'Replanned')
  }
}

export function objectiveRevisionStatusLabel(value: ObjectiveRevisionStatus): string {
  switch (value) {
    case 'draft':
      return translate('fork.heimdallObjective.value.revision.draft', 'Draft')
    case 'approved':
      return translate('fork.heimdallObjective.value.revision.approved', 'Approved')
    case 'rejected':
      return translate('fork.heimdallObjective.value.revision.rejected', 'Rejected')
    case 'superseded':
      return translate('fork.heimdallObjective.value.revision.superseded', 'Superseded')
  }
}

export function objectiveReviewRoleLabel(value: ObjectiveReviewRole): string {
  return value === 'reviewer'
    ? translate('fork.heimdallObjective.value.reviewRole.reviewer', 'Reviewer')
    : translate('fork.heimdallObjective.value.reviewRole.integrator', 'Integrator')
}

export function objectiveVerdictLabel(value: ObjectiveVerdict): string {
  return value === 'approve'
    ? translate('fork.heimdallObjective.value.verdict.approve', 'Approve')
    : translate('fork.heimdallObjective.value.verdict.block', 'Block')
}

export function objectiveCriterionReviewLabel(value: 'pass' | 'block'): string {
  return value === 'pass'
    ? translate('fork.heimdallObjective.value.criterionReview.pass', 'Pass')
    : translate('fork.heimdallObjective.value.criterionReview.block', 'Block')
}
