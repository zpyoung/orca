import type { ObjectiveDetail } from '../../shared/fork-heimdall-objective/detail-types'
import type {
  HeimdallFleetSnapshot,
  WatcherCommandResult,
  WatcherDetail
} from '../../shared/fork-heimdall/fleet-types'
import {
  getLatestEscalations,
  getLatestUnresolvedAwaitingApprovalEscalation
} from '../../shared/fork-heimdall/ledger-queries'

export function formatHeimdallFleet(snapshot: HeimdallFleetSnapshot): string {
  if (snapshot.entries.length === 0) {
    return 'No Heimdall watchers enrolled.'
  }
  return snapshot.entries
    .map((row) => {
      const phase = row.workflowPhase ?? row.entry.status.phase
      const paused = row.paused ? 'paused' : 'not paused'
      const workspace = row.workspace?.label ?? row.entry.enrollment.workspacePath
      return `${row.target.watcherId}  ${row.entry.enrollment.kind}  ${row.entry.status.state}  phase ${phase}  ${paused}  ${workspace}  owner contact ${row.contact}`
    })
    .join('\n')
}

export function formatWatcherDetail(detail: WatcherDetail): string {
  const row = detail.watcher
  const enrollment = row.entry.enrollment
  const status = row.entry.status
  const activeLimit =
    enrollment.budget.wallClockActiveMs === null
      ? 'none'
      : `${enrollment.budget.wallClockActiveMs} ms`
  const turnLimit = enrollment.budget.turns === null ? 'none' : `${enrollment.budget.turns} turns`
  const lines = [
    `Watcher ${row.target.watcherId}`,
    `Kind: ${enrollment.kind}`,
    `State: ${status.state}${status.reason ? ` — ${status.reason}` : ''}`,
    `Owner: ${row.ownerFence.executionHostId} / ${row.ownerFence.schedulerOwner}`,
    `Workspace: ${row.workspace?.label ?? enrollment.workspacePath}`,
    `Owner contact: ${row.contact}`,
    `Enabled: ${String(enrollment.enabled)}; paused: ${String(row.paused)}`,
    `Budget policy: ${activeLimit} / ${turnLimit}`,
    `Ledger entries: ${detail.ledger.entries.length}; traces: ${detail.traces.length}; workers: ${detail.workers.length}`
  ]
  let hasOpenEscalation = false
  for (const escalation of getLatestEscalations(detail.ledger)) {
    if (escalation.status !== 'open' && escalation.status !== 'escalated') {
      continue
    }
    if (!hasOpenEscalation) {
      lines.push('Open escalations:')
      hasOpenEscalation = true
    }
    let approvable = false
    if (
      escalation.escalationKind === 'awaiting-approval' &&
      escalation.approvalScope !== undefined
    ) {
      const latestForScope = getLatestUnresolvedAwaitingApprovalEscalation(
        detail.ledger,
        escalation.approvalScope
      )
      approvable = latestForScope?.escalationId === escalation.escalationId
    }
    lines.push(
      `- ${escalation.escalationId} (${escalation.escalationKind}, ${escalation.status}${approvable ? ', approvable' : ''})`
    )
  }
  if (!hasOpenEscalation) {
    lines.push('Open escalations: none')
  }
  if (status.parkReason) {
    lines.push(`Parked on: ${status.parkReason.kind}`)
  }
  if (row.readOnlyReason) {
    lines.push(`Read-only: ${row.readOnlyReason}`)
  }
  for (const worker of detail.workers) {
    lines.push(`Worker ${worker.dispatchId}: ${worker.liveness} — ${worker.task}`)
    if (worker.reason) {
      lines.push(`  ${worker.reason}`)
    }
    if (worker.question) {
      lines.push(`  Question ${worker.question.messageId}: ${worker.question.body}`)
    }
  }
  return lines.join('\n')
}

export function formatObjectiveDetail(detail: ObjectiveDetail): string {
  const counts = new Map<string, number>()
  for (const node of detail.nodes) {
    counts.set(node.state, (counts.get(node.state) ?? 0) + 1)
  }
  const progress = [...counts.entries()].map(([state, count]) => `${state}: ${count}`).join(', ')
  const lines = [
    `Objective: ${detail.contract.objectiveText}`,
    `Plan: ${detail.revisions.length} revisions; ${detail.nodes.length} tasks${progress ? ` (${progress})` : ''}`,
    `Landing target: ${detail.contract.landingBar}`
  ]
  for (const revision of detail.revisions) {
    lines.push(
      `Revision ${revision.number} [${revision.status}]: ${revision.nodeCount} tasks (${revision.digest})`
    )
  }
  for (const node of detail.nodes) {
    lines.push(`- ${node.taskKey} [${node.state}] ${node.title}`)
  }
  if (detail.landing.length === 0) {
    lines.push('Landing state: no landing records')
  } else {
    for (const landing of detail.landing) {
      lines.push(`Landed at ${landing.rung} (${landing.contentIdentity})`)
    }
  }
  if (detail.pendingPatch) {
    lines.push(`Pending plan patch: ${detail.pendingPatch.id} (${detail.pendingPatch.status})`)
  }
  return lines.join('\n')
}

export function formatWatcherCommandResult(
  result: WatcherCommandResult,
  appliedText: string
): string {
  if (result.status === 'applied') {
    return appliedText
  }
  if (result.status === 'refused') {
    return `Watcher command refused (${result.reason}): ${result.detail}`
  }
  return `Watcher command is indeterminate: ${result.detail}`
}
