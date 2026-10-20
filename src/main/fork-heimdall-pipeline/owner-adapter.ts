import { z } from 'zod'
import type {
  KernelAction,
  OwnerAdapter,
  OwnerStateBrief,
  OwnerStateBriefContext
} from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PipelineNodeDeviation } from '../../shared/fork-heimdall/owner/deviation'
import { ownerDeviationEscalationId } from '../../shared/fork-heimdall/owner/deviation'
import {
  KindAgnosticInterventionSchema,
  type Intervention
} from '../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  scopeLedgerForNode,
  wrapCompositeAction
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter/run-state'
import type { PipelineCompositeOwnerContext, PipelineCompositeOwnerDelegate } from './pipeline-kind'
import {
  buildPipelineOwnerChoiceAction,
  findCurrentOpenPipelineDeviation,
  findCurrentOpenPipelineDeviationForNode,
  PipelineChoiceInterventionSchema,
  rejectPipelineOwnerChoice
} from './pipeline-owner-choice-policy'
import type {
  PipelineChoiceIntervention,
  PipelineOwnerOpenDeviation
} from './pipeline-owner-choice-policy'
import { isPipelineInvalidConfigurationWorld } from './pipeline-kind-read'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'

export { PipelineChoiceInterventionSchema }
export type { PipelineChoiceIntervention }

export type PipelineOwnerAdapter = OwnerAdapter<PipelineKindWorld, KernelAction>

export type PipelineOwnerAdapterDependencies = Readonly<{
  compositeOwner: PipelineCompositeOwnerDelegate
}>

type ReadyWorld = PipelineReadyWorld

function runState(world: ReadyWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
}

function sitterOwnerContext(
  world: ReadyWorld,
  ledger: WatcherLedger,
  enrollment: WatcherEnrollment,
  expectedDeviation?: PipelineNodeDeviation
): PipelineCompositeOwnerContext | null {
  let open: PipelineOwnerOpenDeviation | null = null
  if (expectedDeviation !== undefined) {
    open = findCurrentOpenPipelineDeviation(
      world,
      ledger,
      ownerDeviationEscalationId(world.watcherId, expectedDeviation),
      expectedDeviation.nodeInstanceId
    )
    if (open === null) {
      return null
    }
    const actualDeviation = open.deviation
    if (
      expectedDeviation.nodeInstanceId !== actualDeviation.nodeInstanceId ||
      expectedDeviation.epoch !== actualDeviation.epoch ||
      expectedDeviation.attempt !== actualDeviation.attempt ||
      expectedDeviation.cause !== actualDeviation.cause ||
      expectedDeviation.deadlineMs !== actualDeviation.deadlineMs ||
      expectedDeviation.detail !== actualDeviation.detail ||
      expectedDeviation.options.length !== actualDeviation.options.length ||
      !expectedDeviation.options.every((choice, index) => choice === actualDeviation.options[index])
    ) {
      return null
    }
  } else {
    for (const node of world.payload.document.nodes) {
      if (node.type !== 'pr-sitter') {
        continue
      }
      const candidate = findCurrentOpenPipelineDeviationForNode(world, ledger, node.id)
      if (candidate === null) {
        continue
      }
      if (open !== null) {
        return null
      }
      open = candidate
    }
  }
  if (open === null || open.node.type !== 'pr-sitter') {
    return null
  }
  const deviation = open.deviation
  const composite = world.composites[deviation.nodeInstanceId]
  if (
    world.compositeReadErrors?.[deviation.nodeInstanceId] !== undefined ||
    composite === undefined
  ) {
    return null
  }
  return {
    nodeInstanceId: deviation.nodeInstanceId,
    epoch: deviation.epoch,
    innerSnapshot: composite.snapshot,
    scopedLedger: scopeLedgerForNode(ledger, deviation.nodeInstanceId, deviation.epoch),
    enrollment
  }
}

function boundedBrief(text: string, maxBytes: number): OwnerStateBrief {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false }
  }
  const marker = '[truncated]'
  const limit = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  let bounded = ''
  let used = 0
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > limit) {
      break
    }
    bounded += character
    used += bytes
  }
  const suffix = Buffer.byteLength(marker, 'utf8') <= maxBytes ? marker : ''
  return { text: `${bounded}${suffix}`, truncated: true }
}

function pipelineOwnerState(
  snapshot: Snapshot<PipelineKindWorld>,
  ledger: WatcherLedger,
  maxBytes: number,
  context: OwnerStateBriefContext | undefined,
  compositeOwner: PipelineCompositeOwnerDelegate
): OwnerStateBrief {
  const world = snapshot.world
  if (!isPipelineInvalidConfigurationWorld(world)) {
    const deviation = context?.deviation
    if (deviation?.kind === 'pipeline-node') {
      const open = findCurrentOpenPipelineDeviation(
        world,
        ledger,
        ownerDeviationEscalationId(world.watcherId, deviation),
        deviation.nodeInstanceId
      )
      if (open?.node.type === 'pr-sitter') {
        const ownerContext = sitterOwnerContext(world, ledger, world.enrollment, open.deviation)
        if (ownerContext !== null) {
          return compositeOwner.describeState({
            ...ownerContext,
            maxBytes,
            deviation: open.deviation
          })
        }
      }
    }
    const state = runState(world, ledger)
    const nodes = [...state.nodes].map(([id, node]) => ({
      id,
      status: node.status,
      epoch: node.epoch,
      attempt: node.attempt,
      ...(node.waitingFor === undefined ? {} : { waitingFor: node.waitingFor }),
      ...(node.phase === undefined ? {} : { phase: node.phase }),
      ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
      ...(node.failure === undefined ? {} : { failure: node.failure })
    }))
    const trigger =
      deviation === undefined
        ? undefined
        : {
            kind: deviation.kind,
            detail: deviation.detail,
            ...(deviation.kind === 'pipeline-node'
              ? {
                  escalationId: ownerDeviationEscalationId(world.watcherId, deviation),
                  nodeInstanceId: deviation.nodeInstanceId,
                  epoch: deviation.epoch,
                  attempt: deviation.attempt,
                  cause: deviation.cause,
                  options: deviation.options,
                  ...(deviation.deadlineMs === undefined
                    ? {}
                    : { deadlineMs: deviation.deadlineMs })
                }
              : {})
          }
    return boundedBrief(
      JSON.stringify({
        pipeline: world.payload.document.name,
        pin: world.payload.pin.contentHash,
        observedAtMs: snapshot.observedAtMs,
        terminal: state.terminal,
        ...(trigger === undefined ? {} : { trigger }),
        nodes
      }),
      maxBytes
    )
  }
  return boundedBrief(
    JSON.stringify({
      pipeline: 'invalid-configuration',
      watcherId: world.watcherId,
      field: world.invalidConfiguration.field,
      detail: world.invalidConfiguration.detail,
      observedAtMs: snapshot.observedAtMs,
      ...(context === undefined ? {} : { trigger: context.deviation })
    }),
    maxBytes
  )
}

export function createPipelineOwnerAdapter(
  dependencies: PipelineOwnerAdapterDependencies
): PipelineOwnerAdapter {
  const compositeOwner = dependencies.compositeOwner
  const interventionSchema: z.ZodType<Intervention> = z.union([
    KindAgnosticInterventionSchema,
    PipelineChoiceInterventionSchema,
    compositeOwner.interventionSchema
  ])

  return {
    humanEscalation: 'kind-handles',
    interventionSchema,
    describeInterventions() {
      const own =
        'pipeline-choice: answer only the exact open pipeline-node deviation using one of its listed choices; gate approvals remain person-only.'
      return `${own}
${compositeOwner.describeInterventions()}`
    },
    describeState(snapshot, ledger, maxBytes, context) {
      return pipelineOwnerState(snapshot, ledger, maxBytes, context, compositeOwner)
    },
    rejectIntervention(intervention, snapshot, ledger, enrollment) {
      const choice = PipelineChoiceInterventionSchema.safeParse(intervention)
      if (choice.success) {
        return rejectPipelineOwnerChoice(choice.data, snapshot, ledger, enrollment)
      }
      if (compositeOwner.isSitterIntervention(intervention)) {
        if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
          return {
            gate: 'sitter-overrides',
            reason: 'PR-sitter interventions require a valid current pipeline world.'
          }
        }
        const ownerContext = sitterOwnerContext(snapshot.world, ledger, enrollment)
        if (ownerContext === null) {
          return {
            gate: 'sitter-overrides',
            reason:
              'PR-sitter interventions require one exact open pipeline-node deviation targeting the current sitter.'
          }
        }
        return compositeOwner.rejectIntervention(intervention, ownerContext)
      }
      return {
        gate: 'pipeline-choice',
        reason: 'The pipeline owner adapter received an unsupported intervention.'
      }
    },
    actionForIntervention(intervention, snapshot, ledger) {
      const scopedLedger = ledger ?? snapshot.world.ledger
      const choice = PipelineChoiceInterventionSchema.safeParse(intervention)
      if (choice.success) {
        const rejection = rejectPipelineOwnerChoice(
          choice.data,
          snapshot,
          scopedLedger,
          snapshot.world.enrollment
        )
        if (rejection !== null) {
          throw new Error(rejection.reason)
        }
        if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
          throw new Error(
            'Pipeline owner choices cannot be applied to an invalid configuration world'
          )
        }
        const open = findCurrentOpenPipelineDeviation(
          snapshot.world,
          scopedLedger,
          choice.data.escalationId,
          choice.data.nodeInstanceId
        )
        if (open === null) {
          throw new Error(
            'Pipeline owner choice no longer targets the exact current open deviation'
          )
        }
        return buildPipelineOwnerChoiceAction(
          snapshot.world,
          open.deviation,
          open.node,
          choice.data,
          scopedLedger
        )
      }
      if (compositeOwner.isSitterIntervention(intervention)) {
        if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
          throw new Error(
            'PR-sitter intervention cannot run in an invalid pipeline configuration world'
          )
        }
        const ownerContext = sitterOwnerContext(
          snapshot.world,
          scopedLedger,
          snapshot.world.enrollment
        )
        if (ownerContext === null) {
          throw new Error(
            'PR-sitter intervention no longer targets one exact open sitter deviation'
          )
        }
        const nativeAction = compositeOwner.actionForIntervention(intervention, ownerContext)
        return wrapCompositeAction(
          ownerContext.nodeInstanceId,
          ownerContext.epoch,
          nativeAction,
          `pipeline:${snapshot.world.payload.pin.contentHash}`
        )
      }
      throw new Error('The pipeline owner adapter received an unsupported intervention')
    }
  }
}
