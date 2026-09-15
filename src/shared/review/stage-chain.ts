import { createHash } from 'node:crypto'
import { ChainSchema, MergeChainSchema, type Chain, type MergeChain } from './stage-schemas'
import {
  acceptsPredecessor,
  manifestAcceptsGate,
  type ChainStep,
  type MergeStage,
  type ReviewDepth
} from './run-shape'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export class StageChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StageChainError'
  }
}

function escapeNonAscii(value: string): string {
  return [...value]
    .map((character) => {
      const point = character.codePointAt(0)!
      if (point < 0x80) {
        return character
      }
      if (point <= 0xffff) {
        return `\\u${point.toString(16).padStart(4, '0')}`
      }
      const offset = point - 0x10000
      const high = 0xd800 + (offset >> 10)
      const low = 0xdc00 + (offset & 0x3ff)
      return `\\u${high.toString(16)}\\u${low.toString(16)}`
    })
    .join('')
}

/** Python `json.dumps(sort_keys=True, separators=(',', ':'))` parity for protocol hashes. */
export function canonicalJson(payload: unknown): string {
  const seen = new Set<object>()
  const serialize = (value: unknown): string => {
    if (value === null) {
      return 'null'
    }
    if (typeof value === 'string') {
      return escapeNonAscii(JSON.stringify(value))
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false'
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError('protocol payload contains a non-finite number')
      }
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new TypeError('protocol payload contains a cycle')
      }
      seen.add(value)
      const result = `[${value.map(serialize).join(',')}]`
      seen.delete(value)
      return result
    }
    if (typeof value === 'object') {
      if (seen.has(value)) {
        throw new TypeError('protocol payload contains a cycle')
      }
      seen.add(value)
      const record = value as Record<string, unknown>
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          if (record[key] === undefined) {
            throw new TypeError(`protocol payload field ${key} is undefined`)
          }
          return `${escapeNonAscii(JSON.stringify(key))}:${serialize(record[key])}`
        })
      seen.delete(value)
      return `{${entries.join(',')}}`
    }
    throw new TypeError(`protocol payload contains unsupported ${typeof value}`)
  }
  return serialize(payload)
}

export function digestPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export function chainOf(payload: unknown, label = 'stage'): Chain | MergeChain {
  if (!payload || typeof payload !== 'object' || !('chain' in payload)) {
    throw new StageChainError(`${label} input carries no run chain`)
  }
  const candidate = (payload as { chain: unknown }).chain
  const parsed =
    candidate && typeof candidate === 'object' && (candidate as { step?: unknown }).step === 'merge'
      ? MergeChainSchema.safeParse(candidate)
      : ChainSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new StageChainError(`${label} input has a malformed chain`)
  }
  if ((parsed.data.step === 'resolve') !== (parsed.data.predecessor === null)) {
    throw new StageChainError(`${label} input has a malformed predecessor`)
  }
  return parsed.data
}

export function mintResolveChain(runId: string, artifactHash: string, attempt = 1): Chain {
  return ChainSchema.parse({
    run_id: runId,
    artifact_hash: artifactHash,
    step: 'resolve',
    predecessor: null,
    attempt
  })
}

export function linkStageChain(
  previousPayload: unknown,
  depth: ReviewDepth,
  step: ChainStep,
  attempt = 1,
  stage?: MergeStage
): Chain | MergeChain {
  const previous = chainOf(previousPayload, 'predecessor')
  const previousStage =
    previous.step === 'merge' && 'stage' in previous ? previous.stage : undefined
  if (
    !acceptsPredecessor(depth, step, previous.step, { step: stage, predecessor: previousStage })
  ) {
    throw new StageChainError(
      `${step} does not accept predecessor ${previous.step} at ${depth} depth`
    )
  }
  const next = {
    run_id: previous.run_id,
    artifact_hash: previous.artifact_hash,
    step,
    predecessor: digestPayload(previousPayload),
    attempt,
    ...(step === 'merge' ? { stage } : {})
  }
  return step === 'merge' ? MergeChainSchema.parse(next) : ChainSchema.parse(next)
}

export type BoundChainInput = { label: string; payload: unknown; expectedStep?: ChainStep }

/** Refuses stage bundles mixed across runs or artifact captures. */
export function assertChainAgreement(inputs: readonly BoundChainInput[]): (Chain | MergeChain)[] {
  if (inputs.length === 0) {
    throw new StageChainError('at least one chained input is required')
  }
  const links = inputs.map(({ label, payload, expectedStep }) => {
    const link = chainOf(payload, label)
    if (expectedStep && link.step !== expectedStep) {
      throw new StageChainError(`${label} expects step ${expectedStep}, got ${link.step}`)
    }
    return link
  })
  const first = links[0]
  for (let index = 1; index < links.length; index += 1) {
    const link = links[index]
    if (link.run_id !== first.run_id) {
      throw new StageChainError('inputs belong to different runs')
    }
    if (link.artifact_hash !== first.artifact_hash) {
      throw new StageChainError('inputs describe different artifacts')
    }
  }
  return links
}

export type GateChainInputs = {
  depth: ReviewDepth
  resolve: unknown
  prepass: unknown
  model: unknown
  findings?: unknown
  final?: boolean
  attempt?: number
}

/** Binds every gate input before linking the depth-specific findings predecessor. */
export function createGateChain(inputs: GateChainInputs): Chain {
  const bound: BoundChainInput[] = [
    { label: 'resolve', payload: inputs.resolve, expectedStep: 'resolve' },
    { label: 'prepass', payload: inputs.prepass, expectedStep: 'prepass' },
    { label: 'model', payload: inputs.model, expectedStep: 'select-model' }
  ]
  if (inputs.depth !== 'quick') {
    if (inputs.findings === undefined) {
      throw new StageChainError(`${inputs.depth} gate requires merge output`)
    }
    bound.push({ label: 'findings', payload: inputs.findings, expectedStep: 'merge' })
  }
  assertChainAgreement(bound)
  const step = inputs.final ? 'gate.final' : 'gate'
  const predecessor = inputs.depth === 'quick' ? inputs.model : inputs.findings
  const linked = linkStageChain(predecessor, inputs.depth, step, inputs.attempt ?? 1)
  return ChainSchema.parse(linked)
}

export type ManifestChainInputs = {
  depth: ReviewDepth
  resolve: unknown
  prepass: unknown
  model: unknown
  gate: unknown
  contestedCount: number
  attempt?: number
}

/** Manifest rebinds all inputs and refuses any unsettled gate result. */
export function createManifestChain(inputs: ManifestChainInputs): Chain {
  const gateLink = chainOf(inputs.gate, 'gate')
  if (gateLink.step !== 'gate' && gateLink.step !== 'gate.final') {
    throw new StageChainError(`manifest expects gate input, got ${gateLink.step}`)
  }
  assertChainAgreement([
    { label: 'resolve', payload: inputs.resolve, expectedStep: 'resolve' },
    { label: 'prepass', payload: inputs.prepass, expectedStep: 'prepass' },
    { label: 'model', payload: inputs.model, expectedStep: 'select-model' },
    { label: 'gate', payload: inputs.gate }
  ])
  if (!manifestAcceptsGate(inputs.depth, gateLink.step, inputs.contestedCount)) {
    throw new StageChainError('manifest refuses this gate step or an unsettled contested result')
  }
  const linked = linkStageChain(inputs.gate, inputs.depth, 'manifest', inputs.attempt ?? 1)
  return ChainSchema.parse(linked)
}

export const digest = digestPayload
