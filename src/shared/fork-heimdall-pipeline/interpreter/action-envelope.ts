import type { KernelAction } from '../../fork-heimdall/kind-contract'
import { sha256 } from '../../sha256'
import type { PipelinePin } from '../pipeline-pin'
import { makePipelineNodeEvidenceKey, type PipelineChoiceCause } from '../choice-types'

export type PipelineLandingFacts = {
  branch: string | null
  headSha: string | null
  pushTarget: { remote: string; branch: string; remoteSha: string } | null
  hostedReview: { provider: 'github' | 'gitlab'; repoKey: string; base: string | null } | null
}

export type PipelineInnerIdentity = {
  contentIdentity: string
  evidenceKey: string
}

export type BuildPipelineActionInput = {
  kind: string
  capability: string
  visibility: 'local' | 'external'
  pin: PipelinePin
  instanceId: string
  nodeId: string
  epoch: number
  attempt: number
  cause?: PipelineChoiceCause
  deadlineMs?: number
  inner?: PipelineInnerIdentity
  step?: string
  fields?: Record<string, unknown>
}

/** Builds the stable run-scoped action identity used by every interpreter decision. */
export function buildPipelineAction(input: BuildPipelineActionInput): KernelAction {
  const evidenceKey = makePipelineNodeEvidenceKey({
    instanceId: input.instanceId,
    epoch: input.epoch,
    attempt: input.attempt,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(input.inner === undefined
      ? {}
      : {
          innerContentIdentity: input.inner.contentIdentity,
          innerEvidenceKey: input.inner.evidenceKey
        }),
    ...(input.step === undefined ? {} : { step: input.step })
  })
  return {
    ...input.fields,
    kind: input.kind,
    capability: input.capability,
    visibility: input.visibility,
    contentIdentity: `pipeline:${input.pin.contentHash}`,
    evidenceKey,
    pipelineNode: {
      instanceId: input.instanceId,
      nodeId: input.nodeId,
      epoch: input.epoch,
      attempt: input.attempt,
      ...(input.inner === undefined ? {} : { inner: input.inner })
    }
  }
}

export type PipelineLandActionFacts = PipelineLandingFacts & {
  branch: string
  headSha: string
  target?: PipelineLandingFacts['pushTarget']
  provider?: NonNullable<PipelineLandingFacts['hostedReview']>['provider']
  base?: string | null
  title?: string
  body?: string
  draft?: boolean
}

function pipelineLandTargetDigest(parts: readonly (string | boolean)[]): string {
  const input = new TextEncoder().encode(JSON.stringify(parts))
  let digest = ''
  for (const byte of sha256(input)) {
    digest += byte.toString(16).padStart(2, '0')
  }
  return `pipeline-land:${digest}`
}

/** Binds external Land approval state to the host facts captured for that decision. */
export function landActionExpectedState(
  kind: 'pipeline-land-push' | 'pipeline-land-open-review',
  facts: PipelineLandActionFacts
): { target: string; before: string } | null {
  if (kind === 'pipeline-land-push') {
    const target = facts.target
    if (target === undefined || target === null) {
      return null
    }
    return {
      target: pipelineLandTargetDigest([kind, target.remote, target.branch, facts.headSha]),
      before: target.remoteSha
    }
  }
  const hostedReview = facts.hostedReview
  const provider = facts.provider ?? hostedReview?.provider
  const base = facts.base ?? hostedReview?.base
  const target = facts.target ?? facts.pushTarget
  if (
    hostedReview === null ||
    target === undefined ||
    target === null ||
    provider === undefined ||
    base === undefined ||
    base === null
  ) {
    return null
  }
  return {
    target: pipelineLandTargetDigest([
      kind,
      provider,
      hostedReview.repoKey,
      target.remote,
      target.branch,
      facts.headSha,
      base
    ]),
    before: 'no-review'
  }
}
