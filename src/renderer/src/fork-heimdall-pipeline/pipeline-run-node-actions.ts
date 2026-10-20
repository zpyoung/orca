import { getLatestApproval } from '../../../shared/fork-heimdall/ledger-queries'
import type {
  ApprovalScope,
  EscalationEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { parsePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import { PIPELINE_NODE_TYPES } from '../../../shared/fork-heimdall-pipeline/document-schema'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { pipelineChoicesForNode } from './PipelineGateDialog'

export type PipelineRunNodeControl = {
  node: PipelineRunNodeView
  scope: ApprovalScope
  kind: 'choice' | 'capability'
}

/**
 * The control a run-graph node would open when answered, or null when it must stay inert.
 * The node click and the context menu both ask here, so the menu never offers an answer the
 * click would refuse.
 */
export function pipelineRunNodeControl(input: {
  runNode: PipelineRunNodeView
  view: PipelineRunView
  row: WatcherFleetEntryReader | undefined
  ledger: WatcherLedger | null | undefined
  latestEscalations: readonly EscalationEntry[]
  isUnknownWatcher: boolean
}): PipelineRunNodeControl | null {
  const { runNode, view, row, ledger, latestEscalations, isUnknownWatcher } = input
  const kind =
    runNode.waitingFor === 'gate' || runNode.waitingFor === 'choice'
      ? 'choice'
      : runNode.waitingFor === 'capability-approval'
        ? 'capability'
        : null
  if (
    isUnknownWatcher ||
    !row ||
    !PIPELINE_NODE_TYPES.some((type) => type === runNode.type) ||
    kind === null
  ) {
    return null
  }
  const escalation = latestEscalations.find(
    (entry) =>
      entry.escalationId === runNode.escalationId &&
      (entry.status === 'open' || entry.status === 'escalated') &&
      entry.escalationKind === 'awaiting-approval' &&
      entry.approvalScope !== undefined
  )
  const scope = escalation?.approvalScope
  const identity = scope ? parsePipelineNodeEvidenceKey(scope.evidenceKey) : null
  if (
    !scope ||
    !ledger ||
    getLatestApproval(ledger, scope) !== null ||
    scope.contentIdentity !== `pipeline:${view.pin.contentHash}` ||
    identity?.instanceId !== runNode.instanceId ||
    identity.epoch !== runNode.epoch ||
    identity.attempt !== runNode.attempt
  ) {
    return null
  }
  if (
    (kind === 'choice' &&
      ((runNode.waitingFor === 'gate' && scope.actionKind !== 'pipeline-pass-gate') ||
        (runNode.waitingFor === 'choice' && scope.actionKind !== 'pipeline-apply-choice') ||
        pipelineChoicesForNode(view, runNode, scope).length === 0)) ||
    (kind === 'capability' &&
      (scope.actionKind === 'pipeline-pass-gate' || scope.actionKind === 'pipeline-apply-choice'))
  ) {
    return null
  }
  return { node: runNode, scope, kind }
}

/** True when the node has a live worker terminal that a click or menu pick should open. */
export function pipelineRunNodeOpensWorker(input: {
  runNode: PipelineRunNodeView
  sourceNode: PipelineRunView['document']['nodes'][number] | null
  isUnknownWatcher: boolean
}): boolean {
  const { runNode, sourceNode, isUnknownWatcher } = input
  const isAgentNode =
    sourceNode?.type === 'agent' ||
    (runNode.parentInstanceId !== undefined && sourceNode?.type === 'swarm')
  return (
    !isUnknownWatcher && isAgentNode && runNode.status === 'running' && !!runNode.workerNavigation
  )
}
