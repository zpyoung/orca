import type { DecisionOutcome, KernelAction } from '../../fork-heimdall/kind-contract'
import type { PipelineNode, PipelineDocument, PipelineOutputType } from '../document-schema'
import {
  pipelineChoiceOptions,
  type PipelineChoice,
  type PipelineChoiceCause
} from '../choice-types'
import type { PipelineNodeDeviation } from '../../fork-heimdall/owner/deviation'
import type { PipelineRunState } from './index'
import { childTaskIdFromInstanceId, nodeIdFromInstanceId } from './node-instance'
export type Candidate = { stage: number; order: number; action: KernelAction }
export type ChoiceRouting = {
  deviation?: PipelineNodeDeviation
  candidate?: Candidate
  blocked: boolean
}
export type OutputMap = Readonly<
  Record<string, Readonly<Record<string, { type: PipelineOutputType; value: unknown }>>>
>
export const MAX_RETRY_CONTEXT_LENGTH = 4_000

export function noDecision(reason = 'pipeline-no-action'): DecisionOutcome<KernelAction> {
  return { action: null, reason, considered: [] }
}

export function nodeForInstance(
  document: PipelineDocument,
  instanceId: string
): PipelineNode | undefined {
  return document.nodes.find((node) => node.id === nodeIdFromInstanceId(instanceId))
}

export function nodeTypeForInstance(node: PipelineNode, instanceId: string): string {
  return childTaskIdFromInstanceId(instanceId) === null ? node.type : 'agent'
}

export function nodeSendBackTarget(node: PipelineNode, instanceId: string): string | undefined {
  if (childTaskIdFromInstanceId(instanceId) !== null) {
    return undefined
  }
  return node.type === 'agent' || node.type === 'check' ? node.onFail?.sendBackTo : undefined
}

export function optionsForNode(
  node: PipelineNode,
  instanceId: string,
  cause: PipelineChoiceCause
): readonly PipelineChoice[] {
  const sendBackTo = nodeSendBackTarget(node, instanceId)
  return pipelineChoiceOptions({
    nodeType: nodeTypeForInstance(node, instanceId),
    cause,
    ...(node.type === 'gate' && node.sendBackTo !== undefined
      ? { gateSendBackTo: node.sendBackTo }
      : {}),
    ...(sendBackTo === undefined ? {} : { onFailSendBackTo: sendBackTo })
  })
}

export function boundedDetail(value: string): string {
  return value.length <= MAX_RETRY_CONTEXT_LENGTH ? value : value.slice(0, MAX_RETRY_CONTEXT_LENGTH)
}

export function pipelineComplete(document: PipelineDocument, state: PipelineRunState): boolean {
  const upstream = new Set<string>()
  for (const node of document.nodes) {
    for (const edge of node.after ?? []) {
      upstream.add(typeof edge === 'string' ? edge : edge.node)
    }
  }
  const sinks = document.nodes.filter((node) => !upstream.has(node.id))
  return (
    sinks.length > 0 &&
    sinks.every((node) => {
      const status = state.nodes.get(node.id)?.status
      return status === 'done' || status === 'skipped'
    })
  )
}
