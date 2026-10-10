import type { KernelAction } from '../../fork-heimdall/kind-contract'

export type PipelineNodeIdentity = {
  instanceId: string
  nodeId: string
  epoch: number
  attempt: number
  inner?: { contentIdentity: string; evidenceKey: string }
}

export function nodeInstanceId(nodeId: string, taskId?: string): string {
  return taskId === undefined ? nodeId : `${nodeId}[${taskId}]`
}

export function nodeIdFromInstanceId(instanceId: string): string {
  const childStart = instanceId.indexOf('[')
  return childStart === -1 ? instanceId : instanceId.slice(0, childStart)
}

export function childTaskIdFromInstanceId(instanceId: string): string | null {
  const childStart = instanceId.indexOf('[')
  if (childStart === -1 || !instanceId.endsWith(']')) {
    return null
  }
  const taskId = instanceId.slice(childStart + 1, -1)
  return taskId.length > 0 ? taskId : null
}

export function pipelineNodeIdentity(action: KernelAction): PipelineNodeIdentity | null {
  const candidate = action.pipelineNode
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    !('instanceId' in candidate) ||
    !('nodeId' in candidate) ||
    !('epoch' in candidate) ||
    !('attempt' in candidate)
  ) {
    return null
  }
  if (
    typeof candidate.instanceId !== 'string' ||
    typeof candidate.nodeId !== 'string' ||
    typeof candidate.epoch !== 'number' ||
    !Number.isInteger(candidate.epoch) ||
    candidate.epoch < 0 ||
    typeof candidate.attempt !== 'number' ||
    !Number.isInteger(candidate.attempt) ||
    candidate.attempt < 0
  ) {
    return null
  }
  const innerCandidate = 'inner' in candidate ? candidate.inner : undefined
  if (innerCandidate !== undefined) {
    if (
      innerCandidate === null ||
      typeof innerCandidate !== 'object' ||
      Array.isArray(innerCandidate) ||
      !('contentIdentity' in innerCandidate) ||
      !('evidenceKey' in innerCandidate) ||
      typeof innerCandidate.contentIdentity !== 'string' ||
      typeof innerCandidate.evidenceKey !== 'string'
    ) {
      return null
    }
    return {
      instanceId: candidate.instanceId,
      nodeId: candidate.nodeId,
      epoch: candidate.epoch,
      attempt: candidate.attempt,
      inner: {
        contentIdentity: innerCandidate.contentIdentity,
        evidenceKey: innerCandidate.evidenceKey
      }
    }
  }
  return {
    instanceId: candidate.instanceId,
    nodeId: candidate.nodeId,
    epoch: candidate.epoch,
    attempt: candidate.attempt
  }
}
