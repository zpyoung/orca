import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { parsePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'

export type ApprovalNotificationAction = Pick<KernelAction, 'kind' | 'evidenceKey'>

/** Builds approval notification copy from the pinned pipeline rather than an action identifier. */
export function approvalNotificationCopy(
  enrollment: WatcherEnrollment,
  action: ApprovalNotificationAction
): { title: string; body: string } {
  if (
    enrollment.kind !== 'pipeline' ||
    (action.kind !== 'pipeline-pass-gate' && action.kind !== 'pipeline-apply-choice')
  ) {
    return genericApprovalNotificationCopy(action)
  }
  const payload = PipelineEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
  const evidenceKey = parsePipelineNodeEvidenceKey(action.evidenceKey)
  if (!payload.success || !evidenceKey) {
    return genericApprovalNotificationCopy(action)
  }
  const bracket = evidenceKey.instanceId.indexOf('[')
  const nodeId = bracket === -1 ? evidenceKey.instanceId : evidenceKey.instanceId.slice(0, bracket)
  const node = payload.data.document.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) {
    return genericApprovalNotificationCopy(action)
  }
  if (action.kind === 'pipeline-pass-gate' && node.type === 'gate') {
    return {
      title: `${payload.data.document.name} is waiting at ${node.label}`,
      body: 'Approve, send back or abort in Heimdall.'
    }
  }
  if (action.kind === 'pipeline-apply-choice' && evidenceKey.cause) {
    return {
      title: `${payload.data.document.name} needs a decision`,
      body: `${node.label ?? node.id}: ${evidenceKey.cause}`
    }
  }
  return genericApprovalNotificationCopy(action)
}

function genericApprovalNotificationCopy(action: ApprovalNotificationAction): {
  title: string
  body: string
} {
  return {
    title: 'Watcher approval requested',
    body: `${action.kind} is waiting for approval`
  }
}
