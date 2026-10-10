import { translate } from '@/i18n/i18n'
import type { PipelineRunNodeView } from '../../../shared/fork-heimdall-pipeline/run-view-types'

export const COST_FORMAT = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })

export function statusLabel(status: PipelineRunNodeView['status']): string {
  const labels: Record<PipelineRunNodeView['status'], string> = {
    pending: translate('fork.heimdallPipeline.runGraph.status.pending', 'Pending'),
    running: translate('fork.heimdallPipeline.runGraph.status.running', 'Running'),
    waiting: translate('fork.heimdallPipeline.runGraph.status.waiting', 'Waiting'),
    done: translate('fork.heimdallPipeline.runGraph.status.done', 'Done'),
    failed: translate('fork.heimdallPipeline.runGraph.status.failed', 'Failed'),
    skipped: translate('fork.heimdallPipeline.runGraph.status.skipped', 'Skipped'),
    unverifiable: translate('fork.heimdallPipeline.runGraph.status.unverifiable', 'Unverifiable'),
    unknown: translate('fork.heimdallPipeline.runGraph.status.unknown', 'Unknown')
  }
  return labels[status]
}

export function statusTone(
  status: PipelineRunNodeView['status']
): 'success' | 'warning' | 'neutral' | 'destructive' {
  if (status === 'done') {
    return 'success'
  }
  if (status === 'running' || status === 'waiting') {
    return 'warning'
  }
  if (status === 'failed') {
    return 'destructive'
  }
  return 'neutral'
}

export function phaseName(phase: string): string {
  switch (phase) {
    case 'planning':
      return translate('fork.heimdallPipeline.runGraph.phases.planning', 'Planning')
    case 'plan-review':
      return translate('fork.heimdallPipeline.runGraph.phases.planReview', 'Plan review')
    case 'running-tasks':
      return translate('fork.heimdallPipeline.runGraph.phases.runningTasks', 'Running tasks')
    case 'checks':
      return translate('fork.heimdallPipeline.runGraph.phases.checks', 'Checks')
    case 'review':
      return translate('fork.heimdallPipeline.runGraph.phases.review', 'Review')
    case 'landing':
      return translate('fork.heimdallPipeline.runGraph.phases.landing', 'Landing')
    case 'landed':
      return translate('fork.heimdallPipeline.runGraph.phases.landed', 'Landed')
    case 'watching':
      return translate('fork.heimdallPipeline.runGraph.phases.watching', 'Watching')
    case 'fixing-checks':
      return translate('fork.heimdallPipeline.runGraph.phases.fixingChecks', 'Fixing checks')
    case 'updating-branch':
      return translate('fork.heimdallPipeline.runGraph.phases.updatingBranch', 'Updating branch')
    case 'resolving-conflicts':
      return translate(
        'fork.heimdallPipeline.runGraph.phases.resolvingConflicts',
        'Resolving conflicts'
      )
    case 'merging':
      return translate('fork.heimdallPipeline.runGraph.phases.merging', 'Merging')
    default: {
      const readable = phase.replace(/[-_]+/gu, ' ')
      return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`
    }
  }
}
