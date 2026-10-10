import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { Deviation } from '../../fork-heimdall/owner/deviation'
import type { PipelineNode } from '../document-schema'
import type { PipelineNodeRunState, PipelineRunState, PipelineWorld } from './index'
import { buildPipelineCompositeActivationAction } from './decision-executors'
import { wrapCompositeAction } from './ledger-lens'
import { addCandidate, configurationChoice } from './decision-choices'
import { addDeviation, routeChoiceForNode, routeGenericOwnerDeviation } from './decision-routing'
import type { Candidate } from './decision-types'

export function collectPrSitterDecision(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  node: Extract<PipelineNode, { type: 'pr-sitter' }>
  nodeState: PipelineNodeRunState
  state: PipelineRunState
  order: number
  candidates: Candidate[]
  deviations: { order: number; deviation: Deviation }[]
}): void {
  const { world, ledger, node, nodeState, state, order, candidates, deviations } = input
  const composite = world.composites[node.id]
  const active = world.facts.composites.some(
    (entry) => entry.instanceId === node.id && entry.epoch === nodeState.epoch
  )
  if (!active && nodeState.status === 'ready') {
    const action = buildPipelineCompositeActivationAction({ world, node, state })
    if (action !== null) {
      addCandidate(candidates, world, ledger, action, 0, order)
    } else {
      const result = configurationChoice({
        world,
        ledger,
        node,
        state: nodeState,
        order,
        detail: `PR sitter ${node.id} has no landed review output`
      })
      if (result.deviation !== undefined) {
        addDeviation(deviations, order, result.deviation)
      }
      if (result.candidate !== undefined) {
        candidates.push(result.candidate)
      }
    }
    return
  }
  if (composite === undefined) {
    if (nodeState.status === 'ready' || nodeState.status === 'running') {
      const result = configurationChoice({
        world,
        ledger,
        node,
        state: nodeState,
        order,
        detail: `PR sitter ${node.id} is not readable`
      })
      if (result.deviation !== undefined) {
        addDeviation(deviations, order, result.deviation)
      }
      if (result.candidate !== undefined) {
        candidates.push(result.candidate)
      }
    }
    return
  }
  const stop = composite.evaluateStops()
  if (stop?.disposition === 'terminal') {
    return
  }
  if (stop?.disposition === 'park') {
    if (stop.deviation !== undefined && world.hasOwner) {
      const deviation = routeGenericOwnerDeviation({
        world,
        ledger,
        deviation: stop.deviation,
        order
      })
      if (deviation !== null) {
        addDeviation(deviations, order, deviation)
      }
    } else {
      const route = routeChoiceForNode({
        world,
        ledger,
        node,
        instanceId: node.id,
        state: nodeState,
        cause: 'repeated-failure-after-own-fix',
        detail: stop.detail ?? stop.reason,
        order
      })
      if (route.deviation !== undefined) {
        addDeviation(deviations, order, route.deviation)
      }
      if (route.candidate !== undefined) {
        candidates.push(route.candidate)
      }
    }
    return
  }
  const outcome = composite.decide()
  if (outcome.action !== null) {
    const action = wrapCompositeAction(
      node.id,
      nodeState.epoch,
      outcome.action,
      `pipeline:${world.payload.pin.contentHash}`
    )
    addCandidate(candidates, world, ledger, action, 2, order)
  } else if ('deviation' in outcome) {
    const deviation = routeGenericOwnerDeviation({
      world,
      ledger,
      deviation: outcome.deviation,
      order
    })
    if (deviation !== null) {
      addDeviation(deviations, order, deviation)
    }
  }
}
