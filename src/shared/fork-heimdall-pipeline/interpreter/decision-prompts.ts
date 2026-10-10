import { getAttemptResolution } from '../../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { KernelAction } from '../../fork-heimdall/kind-contract'
import type {
  PipelineAgentNode,
  PipelineDocument,
  PipelineNode,
  PipelineScriptNode,
  PipelineSwarmNode
} from '../document-schema'
import { renderPrompt, type PipelineOutputValue } from '../output-substitution'
import { ScriptEnvTooLargeError, scriptApprovalDigest } from '../script-env'
import type { PipelineRunState, PipelineWorld } from './index'
import { buildPipelineAction } from './action-envelope'
import type { OutputMap } from './decision-types'
import { pipelineAttemptFacts } from './node-history'
import { loopReentryNode } from './loop-rules'
import { nodeIdFromInstanceId } from './node-instance'
import { pipelineOutputReference } from './decision-rules'
import { decodePipelineVerdict } from './verdict-output'

const RETRY_CONTEXT_LIMIT = 4_000

export function pipelineOutputs(world: PipelineWorld, state: PipelineRunState): OutputMap {
  const outputs: Record<string, Record<string, PipelineOutputValue>> = {}
  for (const node of world.payload.document.nodes) {
    const nodeState = state.nodes.get(node.id)
    if (nodeState?.outputs === undefined) {
      continue
    }
    const declared =
      node.type === 'agent'
        ? node.outputs
        : node.type === 'swarm'
          ? node.child.outputs
          : node.type === 'script'
            ? node.outputs
            : undefined
    const typed: Record<string, PipelineOutputValue> = {}
    for (const [name, value] of Object.entries(nodeState.outputs)) {
      const type =
        node.type === 'script'
          ? name === 'stdout' && node.outputs?.stdout !== undefined
            ? node.outputs.stdout
            : undefined
          : declared?.[name]
      if (type !== undefined) {
        typed[name] = { type, value }
      }
    }
    outputs[node.id] = typed
  }
  for (const row of world.facts.outputs) {
    if (!row.instanceId.includes('[')) {
      continue
    }
    const swarm = world.payload.document.nodes.find(
      (node): node is PipelineSwarmNode =>
        node.id === row.instanceId.slice(0, row.instanceId.indexOf('[')) && node.type === 'swarm'
    )
    const childState = state.nodes.get(row.instanceId)
    if (
      swarm === undefined ||
      childState?.epoch !== row.epoch ||
      childState.attempt !== row.attempt
    ) {
      continue
    }
    const typed: Record<string, PipelineOutputValue> = {}
    for (const [name, value] of Object.entries(row.outputs)) {
      const type = swarm.child.outputs?.[name]
      if (type !== undefined) {
        typed[name] = { type, value }
      }
    }
    outputs[row.instanceId] = typed
  }
  return outputs
}

function retryContext(
  ledger: WatcherLedger,
  instanceId: string,
  epoch: number
): string | undefined {
  const failed = pipelineAttemptFacts(ledger)
    .filter(
      (fact) =>
        fact.identity.instanceId === instanceId &&
        fact.identity.epoch === epoch &&
        fact.entry.state === 'settled' &&
        fact.effect === 'not-landed'
    )
    .sort((left, right) => right.entry.atMs - left.entry.atMs)[0]
  if (failed === undefined) {
    return undefined
  }
  const sections: string[] = []
  if (failed.entry.reason !== undefined) {
    sections.push(failed.entry.reason)
  }
  const result = failed.entry.result
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    if ('outputTail' in result && typeof result.outputTail === 'string') {
      sections.push(result.outputTail)
    }
    if ('validationError' in result && typeof result.validationError === 'string') {
      sections.push(result.validationError)
    }
  }
  const reportValidation = getAttemptResolution(ledger, failed.entry.attemptId)?.reportValidation
  if (reportValidation !== undefined) {
    sections.push(reportValidation.detail ?? reportValidation.code)
  }
  const value = sections.join('\n')
  return value.length === 0
    ? undefined
    : value.length <= RETRY_CONTEXT_LIMIT
      ? value
      : value.slice(0, RETRY_CONTEXT_LIMIT)
}

function reportInstructions(
  node: PipelineAgentNode | PipelineSwarmNode['child'],
  instanceId: string
): string {
  const outputs = node.outputs ?? {}
  const names = Object.keys(outputs)
  const declared = names.length === 0 ? 'no output fields' : names.join(', ')
  return `Write one JSON report for node ${instanceId} with a summary and outputs containing exactly: ${declared}.`
}

function reviewerObjections(
  document: PipelineDocument,
  state: PipelineRunState,
  facts: PipelineWorld['facts'],
  instanceId: string
): string[] | undefined {
  const nodeId = nodeIdFromInstanceId(instanceId)
  for (const loop of document.nodes) {
    if (loop.type !== 'loop' || loopReentryNode(document, loop) !== nodeId) {
      continue
    }
    const reference = pipelineOutputReference(loop.until)
    if (reference === null) {
      continue
    }
    const sourceEpoch = (state.nodes.get(reference.nodeId)?.epoch ?? 0) - 1
    let sourceOutput: Record<string, unknown> | undefined
    for (const row of facts.outputs) {
      if (row.instanceId === reference.nodeId && row.epoch === sourceEpoch) {
        sourceOutput = row.outputs
      }
    }
    if (sourceOutput === undefined) {
      continue
    }
    const verdict = decodePipelineVerdict(sourceOutput[reference.name])
    if (verdict === null || verdict.verdict === 'approve') {
      continue
    }
    const objections = [...(verdict.objections ?? [])]
    if (verdict.reason !== undefined) {
      objections.unshift(`Reason: ${verdict.reason}`)
    }
    return objections.length === 0 ? undefined : objections
  }
  return undefined
}

export function renderPipelineNodePrompt(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  state: PipelineRunState
  outputs: OutputMap
  node: PipelineAgentNode | PipelineSwarmNode['child']
  instanceId: string
  task?: { id: string; title: string; spec: string }
  sendBackComment?: string
}): string | null {
  const epoch = input.state.nodes.get(input.instanceId)?.epoch ?? 0
  const retry = retryContext(input.ledger, input.instanceId, epoch)
  const objections = reviewerObjections(
    input.world.payload.document,
    input.state,
    input.world.facts,
    input.instanceId
  )
  const rendered = renderPrompt({
    prompt: input.node.prompt,
    outputs: input.outputs,
    runInputs: input.world.payload.runInputs,
    workspacePath: input.world.workspacePath,
    ...(retry === undefined ? {} : { retryContext: retry }),
    ...(objections === undefined ? {} : { reviewerObjections: objections }),
    ...(input.sendBackComment === undefined ? {} : { sendBackComment: input.sendBackComment }),
    ...(input.task === undefined ? {} : { task: input.task }),
    reportInstructions: reportInstructions(input.node, input.instanceId)
  })
  return rendered.ok ? rendered.text : null
}

function resolveReference(
  world: PipelineWorld,
  outputs: OutputMap,
  reference: string
): string | null {
  const rendered = renderPrompt({
    prompt: reference,
    outputs,
    runInputs: world.payload.runInputs,
    workspacePath: world.workspacePath
  })
  return rendered.ok ? rendered.text : null
}

export function buildPipelineAgentAction(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  state: PipelineRunState
  node: PipelineAgentNode | PipelineSwarmNode['child']
  instanceId: string
  epoch: number
  attempt: number
  outputs: OutputMap
  task?: { id: string; title: string; spec: string }
  sendBackComment?: string
}): KernelAction | null {
  const spec = renderPipelineNodePrompt(input)
  if (spec === null) {
    return null
  }
  const config = input.world.payload.document.defaults
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: input.world.payload.pin,
    instanceId: input.instanceId,
    nodeId: nodeIdFromInstanceId(input.instanceId),
    epoch: input.epoch,
    attempt: input.attempt,
    fields: {
      agent: input.node.harness ?? config?.harness,
      model: input.node.model ?? config?.model,
      effort: input.node.effort ?? config?.effort,
      taskKey: input.instanceId,
      spec,
      expectedState: {
        target: `pipeline-node:${input.instanceId}`,
        before: `${input.epoch}:${input.attempt}`
      }
    }
  })
}

export function buildPipelineCheckAction(
  world: PipelineWorld,
  node: Extract<PipelineNode, { type: 'check' }>,
  epoch: number,
  attempt: number
): KernelAction {
  return buildPipelineAction({
    kind: 'pipeline-run-check',
    capability: 'check',
    visibility: 'local',
    pin: world.payload.pin,
    instanceId: node.id,
    nodeId: node.id,
    epoch,
    attempt,
    fields: { command: node.command, timeoutSeconds: node.timeoutSeconds }
  })
}

export function buildPipelineScriptAction(input: {
  world: PipelineWorld
  node: PipelineScriptNode
  epoch: number
  attempt: number
  outputs: OutputMap
}): KernelAction | null {
  const env: Record<string, string> = {}
  for (const [name, reference] of Object.entries(input.node.inputs ?? {})) {
    const value = resolveReference(input.world, input.outputs, reference)
    if (value === null) {
      return null
    }
    env[name] = value
  }
  let resolvedInputsDigest: string
  try {
    resolvedInputsDigest = scriptApprovalDigest({ command: input.node.command, env })
  } catch (error) {
    if (error instanceof ScriptEnvTooLargeError) {
      return null
    }
    throw error
  }
  return buildPipelineAction({
    kind: 'pipeline-run-script',
    capability: input.node.capability,
    visibility: 'external',
    pin: input.world.payload.pin,
    instanceId: input.node.id,
    nodeId: input.node.id,
    epoch: input.epoch,
    attempt: input.attempt,
    step: `script:${resolvedInputsDigest}`,
    fields: {
      command: input.node.command,
      env,
      resolvedInputsDigest,
      timeoutSeconds: input.node.timeoutSeconds,
      expectedState: { target: `script:${input.node.id}`, before: resolvedInputsDigest }
    }
  })
}
