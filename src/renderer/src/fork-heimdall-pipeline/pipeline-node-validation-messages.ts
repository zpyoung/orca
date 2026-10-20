import type { PipelineValidationError } from '../../../shared/fork-heimdall-pipeline/pipeline-validate'

/**
 * Groups validation messages by the node they were reported against, in report order.
 * Errors that name no node (document-level problems) are left out.
 */
export function validationMessagesByNode(
  errors: readonly Pick<PipelineValidationError, 'nodeId' | 'message'>[]
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>()
  for (const { nodeId, message } of errors) {
    if (nodeId === null) {
      continue
    }
    const messages = grouped.get(nodeId)
    if (messages) {
      messages.push(message)
    } else {
      grouped.set(nodeId, [message])
    }
  }
  return grouped
}
