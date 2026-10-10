import { z } from 'zod'

import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { CapabilityModeSchema } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type {
  HostedReviewEnrollmentPayload,
  HostedReviewSitterAction,
  HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter/types'
import {
  nodeIdFromInstanceId,
  pipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { unwrapCompositeAction } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelinePrSitterNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  CompositeNodeConfigurationError,
  CompositeScopeError,
  createCompositeNodeHost,
  type CompositeNodeHost
} from './composite-node-host'
import { parseHostedReviewEnrollmentPayload } from '../fork-hosted-review-sitter/definition-store'
import type { HostedReviewKind } from '../fork-hosted-review-sitter/kind'
import {
  isPipelineInvalidConfigurationWorld,
  type PipelineKindWorld,
  type PipelineReadyWorld
} from './pipeline-kind-read'

const SITTER_ACTION_KINDS: Record<HostedReviewSitterAction['kind'], true> = {
  'rerun-check': true,
  'prepare-fix': true,
  'publish-fix': true,
  'prepare-conflict-resolution': true,
  'publish-conflict-resolution': true,
  'update-branch': true,
  merge: true,
  enqueue: true
}
const SITTER_CAPABILITIES_SCHEMA = z
  .object({
    updateBranch: CapabilityModeSchema,
    resolveConflicts: CapabilityModeSchema,
    fixChecks: CapabilityModeSchema,
    merge: CapabilityModeSchema
  })
  .strict()

type ActiveSitterComposite = Readonly<{
  instanceId: string
  epoch: number
  enrollment: WatcherEnrollment
  host: CompositeNodeHost<
    HostedReviewWorld,
    HostedReviewSitterAction,
    HostedReviewEnrollmentPayload
  >
  snapshot: Snapshot<HostedReviewWorld>
}>

export function isSitterAction(action: KernelAction): action is HostedReviewSitterAction {
  return Object.hasOwn(SITTER_ACTION_KINDS, action.kind)
}

export function sitterEnrollment(
  enrollment: WatcherEnrollment,
  kindPayload: unknown,
  capabilities: unknown,
  instanceId: string,
  epoch: number
): WatcherEnrollment {
  const parsedPayload = parseHostedReviewEnrollmentPayload(kindPayload)
  if (parsedPayload === null) {
    throw new CompositeNodeConfigurationError(
      instanceId,
      epoch,
      'The persisted PR-sitter composite payload is invalid'
    )
  }
  const parsedCapabilities = SITTER_CAPABILITIES_SCHEMA.safeParse(capabilities)
  if (!parsedCapabilities.success) {
    throw new CompositeNodeConfigurationError(instanceId, epoch, parsedCapabilities.error)
  }
  return {
    ...enrollment,
    kind: 'hosted-review',
    capabilities: parsedCapabilities.data,
    kindPayload: parsedPayload
  }
}

export function hostedReviewSnapshot(snapshot: Snapshot<unknown>): Snapshot<HostedReviewWorld> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readComposites only stores the exact Snapshot<HostedReviewWorld> returned by the registered hosted-review kind.
  return snapshot as Snapshot<HostedReviewWorld>
}

export function hostedReviewLiveSnapshot(
  snapshot: Snapshot<unknown>
): LiveSnapshot<HostedReviewWorld> | null {
  if (snapshot.freshness !== 'live') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the live composite view is the exact LiveSnapshot returned by the hosted-review kind's fresh read.
  return snapshot as LiveSnapshot<HostedReviewWorld>
}

export function requireWrappedSitterAction(
  action: KernelAction,
  contentIdentity: string
): HostedReviewSitterAction {
  const identity = requireSitterIdentity(action, contentIdentity)
  const inner = unwrapCompositeAction(action)
  if (inner === null || !isSitterAction(inner) || !isSitterAction(action)) {
    throw new CompositeScopeError(identity.instanceId, identity.epoch)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only native hosted-review action kinds are accepted, the ledger-lens wrapper preserves every action field, and requireSitterIdentity verifies its inner evidence identity.
  return action as HostedReviewSitterAction
}

export function activeComposite(
  snapshot: Snapshot<PipelineKindWorld>,
  action: KernelAction,
  hostedReviewKind: HostedReviewKind
): ActiveSitterComposite {
  const world = readyWorld(snapshot)
  const identity = requireSitterIdentity(action, snapshot.contentIdentity)
  const node = world.payload.document.nodes.find(
    (candidate): candidate is PipelinePrSitterNode =>
      candidate.id === identity.nodeId && candidate.type === 'pr-sitter'
  )
  const row = world.facts.composites.find(
    (fact) => fact.instanceId === identity.instanceId && fact.epoch === identity.epoch
  )
  const view = world.composites[identity.instanceId]
  if (!node || !row || row.kind !== 'hosted-review' || !view) {
    throw new CompositeNodeConfigurationError(
      identity.instanceId,
      identity.epoch,
      'The active PR-sitter composite is unavailable'
    )
  }
  const enrollment = sitterEnrollment(
    world.enrollment,
    row.kindPayload,
    row.capabilities,
    identity.instanceId,
    identity.epoch
  )
  const innerSnapshot = hostedReviewSnapshot(view.snapshot)
  return {
    instanceId: identity.instanceId,
    epoch: identity.epoch,
    enrollment,
    host: createCompositeNodeHost(
      hostedReviewKind,
      { kind: 'node-scoped', instanceId: identity.instanceId, epoch: identity.epoch },
      snapshot.contentIdentity
    ),
    snapshot: innerSnapshot
  }
}

function requireSitterIdentity(
  action: KernelAction,
  contentIdentity: string
): {
  instanceId: string
  nodeId: string
  epoch: number
  inner: { contentIdentity: string; evidenceKey: string }
} {
  const identity = pipelineNodeIdentity(action)
  const inner = unwrapCompositeAction(action)
  if (
    identity === null ||
    identity.inner === undefined ||
    inner === null ||
    identity.nodeId !== nodeIdFromInstanceId(identity.instanceId) ||
    action.contentIdentity !== contentIdentity ||
    inner.contentIdentity !== identity.inner.contentIdentity ||
    inner.evidenceKey !== identity.inner.evidenceKey
  ) {
    throw new CompositeScopeError(identity?.instanceId ?? 'unknown', identity?.epoch ?? -1)
  }
  return {
    instanceId: identity.instanceId,
    nodeId: identity.nodeId,
    epoch: identity.epoch,
    inner: identity.inner
  }
}

function readyWorld(snapshot: Snapshot<PipelineKindWorld>): PipelineReadyWorld {
  if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
    throw new Error(snapshot.world.invalidConfiguration.detail)
  }
  return snapshot.world
}
