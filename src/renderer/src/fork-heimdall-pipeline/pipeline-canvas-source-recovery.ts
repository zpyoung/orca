import { z } from 'zod'
import {
  PIPELINE_NODE_TYPES,
  PipelineDocumentSchema,
  PipelineNodeSchema,
  type NodeType,
  type PipelineDocument,
  type PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'

const TOP_LEVEL_FIELDS: Readonly<Record<string, true>> = {
  version: true,
  id: true,
  name: true,
  description: true,
  inputs: true,
  capabilities: true,
  defaults: true,
  nodes: true
}

const NODE_FIELDS: Readonly<Record<NodeType, readonly string[]>> = {
  agent: [
    'id',
    'type',
    'label',
    'after',
    'harness',
    'model',
    'effort',
    'prompt',
    'outputs',
    'retry',
    'timeLimitMinutes',
    'onFail'
  ],
  check: ['id', 'type', 'label', 'after', 'command', 'timeoutSeconds', 'retry', 'onFail'],
  script: [
    'id',
    'type',
    'label',
    'after',
    'command',
    'capability',
    'inputs',
    'timeoutSeconds',
    'outputs'
  ],
  decision: ['id', 'type', 'label', 'after', 'on'],
  loop: ['id', 'type', 'label', 'after', 'body', 'until', 'maxRounds'],
  swarm: ['id', 'type', 'label', 'after', 'from', 'maxParallel', 'worktree', 'child'],
  merge: ['id', 'type', 'label', 'after', 'from'],
  gate: ['id', 'type', 'label', 'after', 'sendBackTo', 'notify'],
  land: ['id', 'type', 'label', 'after', 'title', 'body', 'draft', 'commitMessage'],
  objective: [
    'id',
    'type',
    'label',
    'after',
    'tier',
    'landingBar',
    'checks',
    'roleAgents',
    'maxConcurrency',
    'lanesEnabled'
  ],
  'pr-sitter': [
    'id',
    'type',
    'label',
    'after',
    'repeatFixLimit',
    'branchUpdateMode',
    'mergeMethod',
    'mergeCheckScope'
  ]
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value)
  return parsed.success ? parsed.data : null
}

function hasOnlyFields(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function prepareNonEmptyString(
  source: Record<string, unknown>,
  candidate: Record<string, unknown>,
  key: string,
  replacement: string,
  required = false
): boolean {
  if (!Object.hasOwn(source, key)) {
    if (required) {
      candidate[key] = replacement
    }
    return true
  }
  if (typeof source[key] !== 'string') {
    return false
  }
  if (source[key].trim().length === 0) {
    candidate[key] = replacement
  }
  return true
}

function prepareNumber(
  source: Record<string, unknown>,
  candidate: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  replacement: number,
  required = false
): boolean {
  if (!Object.hasOwn(source, key)) {
    if (required) {
      candidate[key] = replacement
    }
    return true
  }
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    candidate[key] = replacement
  }
  return true
}
function recoverPipelineNode(value: unknown): PipelineNode | null {
  const source = recordFrom(value)
  if (!source || typeof source.id !== 'string') {
    return null
  }
  const type = PIPELINE_NODE_TYPES.find((candidate) => candidate === source.type)
  if (!type || !hasOnlyFields(source, NODE_FIELDS[type])) {
    return null
  }
  const candidate: Record<string, unknown> = { ...source }
  if (type === 'agent') {
    if (typeof source.prompt !== 'string' && source.prompt !== undefined) {
      return null
    }
    candidate.prompt = source.prompt ?? ''
    if (!prepareNonEmptyString(source, candidate, 'harness', 'x')) {
      return null
    }
    if (!prepareNonEmptyString(source, candidate, 'model', 'x')) {
      return null
    }
    if (!prepareNumber(source, candidate, 'retry', 0, 5, 0)) {
      return null
    }
    if (!prepareNumber(source, candidate, 'timeLimitMinutes', 1, 1440, 1)) {
      return null
    }
  } else if (type === 'check' || type === 'script') {
    if (!prepareNonEmptyString(source, candidate, 'command', 'x', true)) {
      return null
    }
    if (type === 'script' && source.capability === undefined) {
      return null
    }
    if (type === 'check') {
      if (!prepareNumber(source, candidate, 'timeoutSeconds', 10, 14400, 1800)) {
        return null
      }
      if (!prepareNumber(source, candidate, 'retry', 0, 5, 0)) {
        return null
      }
    } else if (!prepareNumber(source, candidate, 'timeoutSeconds', 10, 14400, 1800)) {
      return null
    }
  } else if (type === 'decision') {
    if (!prepareNonEmptyString(source, candidate, 'on', '$x.outputs.x', true)) {
      return null
    }
  } else if (type === 'loop') {
    if (!prepareNonEmptyString(source, candidate, 'until', '$x.outputs.x', true)) {
      return null
    }
    if (!Array.isArray(source.body) || source.body.length === 0) {
      if (source.body !== undefined && !Array.isArray(source.body)) {
        return null
      }
      candidate.body = [source.id]
    }
    if (!prepareNumber(source, candidate, 'maxRounds', 1, 10, 1, true)) {
      return null
    }
  } else if (type === 'swarm') {
    if (!prepareNonEmptyString(source, candidate, 'from', '$x.outputs.x', true)) {
      return null
    }
    const sourceChild = source.child === undefined ? {} : recordFrom(source.child)
    if (!sourceChild) {
      return null
    }
    const candidateChild: Record<string, unknown> = { ...sourceChild }
    if (!prepareNonEmptyString(sourceChild, candidateChild, 'harness', 'x', true)) {
      return null
    }
    if (!prepareNonEmptyString(sourceChild, candidateChild, 'model', 'x')) {
      return null
    }
    if (sourceChild.prompt === undefined) {
      candidateChild.prompt = ''
    } else if (typeof sourceChild.prompt !== 'string') {
      return null
    }
    if (!prepareNumber(sourceChild, candidateChild, 'retry', 0, 5, 0)) {
      return null
    }
    if (!prepareNumber(sourceChild, candidateChild, 'timeLimitMinutes', 1, 1440, 1)) {
      return null
    }
    candidate.child = candidateChild
    if (!prepareNumber(source, candidate, 'maxParallel', 1, 5, 5)) {
      return null
    }
    if (source.worktree === undefined) {
      candidate.worktree = 'own'
    }
  } else if (type === 'merge') {
    if (!prepareNonEmptyString(source, candidate, 'from', 'x', true)) {
      return null
    }
  } else if (type === 'gate') {
    if (!prepareNonEmptyString(source, candidate, 'label', 'x', true)) {
      return null
    }
    if (source.notify === undefined) {
      candidate.notify = true
    }
  } else if (type === 'land') {
    if (source.draft === undefined) {
      candidate.draft = false
    }
  } else if (type === 'objective') {
    if (!prepareNumber(source, candidate, 'maxConcurrency', 1, 1024, 1)) {
      return null
    }
  } else if (type === 'pr-sitter') {
    if (!prepareNumber(source, candidate, 'repeatFixLimit', 1, 10, 3)) {
      return null
    }
    if (source.repeatFixLimit === undefined) {
      candidate.repeatFixLimit = 3
    }
    if (source.mergeCheckScope === undefined) {
      candidate.mergeCheckScope = 'all'
    }
  }

  const parsed = PipelineNodeSchema.safeParse(candidate)
  if (!parsed.success) {
    return null
  }
  const node = parsed.data
  if (node.type === 'agent') {
    return {
      ...node,
      prompt: typeof source.prompt === 'string' ? source.prompt : '',
      ...(typeof source.harness === 'string' ? { harness: source.harness } : {}),
      ...(typeof source.model === 'string' ? { model: source.model } : {}),
      ...(typeof source.retry === 'number' ? { retry: source.retry } : {}),
      ...(typeof source.timeLimitMinutes === 'number'
        ? { timeLimitMinutes: source.timeLimitMinutes }
        : {})
    }
  }
  if (node.type === 'check') {
    return {
      ...node,
      command: typeof source.command === 'string' ? source.command : '',
      ...(typeof source.timeoutSeconds === 'number'
        ? { timeoutSeconds: source.timeoutSeconds }
        : {}),
      ...(typeof source.retry === 'number' ? { retry: source.retry } : {})
    }
  }
  if (node.type === 'script') {
    return {
      ...node,
      command: typeof source.command === 'string' ? source.command : '',
      ...(typeof source.timeoutSeconds === 'number'
        ? { timeoutSeconds: source.timeoutSeconds }
        : {})
    }
  }
  if (node.type === 'decision') {
    return { ...node, on: typeof source.on === 'string' ? source.on : '' }
  }
  if (node.type === 'loop') {
    return {
      ...node,
      body: Array.isArray(source.body) && source.body.length > 0 ? node.body : [],
      until: typeof source.until === 'string' ? source.until : '',
      maxRounds: typeof source.maxRounds === 'number' ? source.maxRounds : 0
    }
  }
  if (node.type === 'swarm') {
    const sourceChild = recordFrom(source.child) ?? {}
    return {
      ...node,
      from: typeof source.from === 'string' ? source.from : '',
      ...(typeof source.maxParallel === 'number' ? { maxParallel: source.maxParallel } : {}),
      child: {
        ...node.child,
        harness: typeof sourceChild.harness === 'string' ? sourceChild.harness : '',
        ...(typeof sourceChild.model === 'string' ? { model: sourceChild.model } : {}),
        prompt: typeof sourceChild.prompt === 'string' ? sourceChild.prompt : '',
        ...(typeof sourceChild.retry === 'number' ? { retry: sourceChild.retry } : {}),
        ...(typeof sourceChild.timeLimitMinutes === 'number'
          ? { timeLimitMinutes: sourceChild.timeLimitMinutes }
          : {})
      }
    }
  }
  if (node.type === 'merge') {
    return { ...node, from: typeof source.from === 'string' ? source.from : '' }
  }
  if (node.type === 'gate') {
    return { ...node, label: typeof source.label === 'string' ? source.label : '' }
  }
  if (node.type === 'objective') {
    return {
      ...node,
      ...(typeof source.maxConcurrency === 'number'
        ? { maxConcurrency: source.maxConcurrency }
        : {})
    }
  }
  if (node.type === 'pr-sitter') {
    return {
      ...node,
      ...(typeof source.repeatFixLimit === 'number'
        ? { repeatFixLimit: source.repeatFixLimit }
        : {})
    }
  }
  return node
}

/** Restore only known, structurally editable drafts from the parser's decoded YAML candidate. */
export function recoverPipelineDraftDocument(sourceDocument: unknown): PipelineDocument | null {
  const source = recordFrom(sourceDocument)
  if (
    !source ||
    !hasOnlyFields(source, Object.keys(TOP_LEVEL_FIELDS)) ||
    source.version !== 1 ||
    typeof source.id !== 'string' ||
    typeof source.name !== 'string' ||
    !Array.isArray(source.nodes)
  ) {
    return null
  }
  const description = PipelineDocumentSchema.shape.description.safeParse(source.description)
  const inputs = PipelineDocumentSchema.shape.inputs.safeParse(source.inputs)
  const capabilities = PipelineDocumentSchema.shape.capabilities.safeParse(source.capabilities)
  const defaults = PipelineDocumentSchema.shape.defaults.safeParse(source.defaults)
  if (!description.success || !inputs.success || !capabilities.success || !defaults.success) {
    return null
  }
  const nodes: PipelineNode[] = []
  for (const rawNode of source.nodes) {
    const node = recoverPipelineNode(rawNode)
    if (!node) {
      return null
    }
    nodes.push(node)
  }
  return {
    version: 1,
    id: source.id,
    name: source.name,
    inputs: inputs.data,
    nodes,
    ...(description.data === undefined ? {} : { description: description.data }),
    ...(capabilities.data === undefined ? {} : { capabilities: capabilities.data }),
    ...(defaults.data === undefined ? {} : { defaults: defaults.data })
  }
}
