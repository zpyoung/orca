import type { DecisionOutcome, KernelAction } from '../../fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { Deviation, PipelineNodeDeviation } from '../../fork-heimdall/owner/deviation'
import type { PipelineWorld } from './index'
import type { PipelineChoiceCause } from '../choice-types'
import { pipelineOutputReference, topologicalPipelineNodes } from './decision-rules'
import {
  addCandidate,
  buildGateAction,
  configurationChoice,
  pendingAnswerCandidates
} from './decision-choices'
import {
  buildPipelineAgentAction,
  buildPipelineCheckAction,
  buildPipelineScriptAction,
  pipelineOutputs
} from './decision-prompts'
import { buildNextLandAction, buildPipelineSwarmExpansionAction } from './decision-executors'
import { derivePipelineHistory } from './state-history'
import { childTaskIdFromInstanceId, nodeInstanceId, pipelineNodeIdentity } from './node-instance'
import { derivePipelineRunState } from './run-state'
import { readySwarmChildren } from './swarm-rules'
import { loopVerdict } from './loop-rules'
import { pipelineAttemptFacts } from './node-history'
import type { Candidate } from './decision-types'
import { noDecision } from './decision-types'
import {
  addDeviation,
  addTimeLimitChoice,
  latestSwarmExpansion,
  routeChoiceForNode
} from './decision-routing'
import { addMergeCandidates } from './decision-merge'
import { collectPrSitterDecision } from './decision-sitter'

function hasPendingAnsweredControl(candidates: readonly Candidate[], instanceId: string): boolean {
  return candidates.some((candidate) => {
    if (
      candidate.action.kind !== 'pipeline-apply-choice' &&
      candidate.action.kind !== 'pipeline-pass-gate'
    ) {
      return false
    }
    return pipelineNodeIdentity(candidate.action)?.instanceId === instanceId
  })
}

/** Returns one deterministic next action, a new owner deviation, or no work. */
function decidePipelineTickInternal(
  world: PipelineWorld,
  ledger: WatcherLedger,
  preferredNodeInstanceId?: string
): DecisionOutcome<KernelAction> {
  const state = derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
  if (state.terminal !== null) {
    return noDecision(`pipeline-${state.terminal}`)
  }
  const document = world.payload.document
  const orderedNodes = topologicalPipelineNodes(document)
  const orderByNode = new Map(orderedNodes.map((node, index) => [node.id, index]))
  const candidates = pendingAnswerCandidates(world, ledger, orderByNode)
  const deviations: { order: number; deviation: Deviation }[] = []
  const outputs = pipelineOutputs(world, state)
  const history = derivePipelineHistory(document, ledger)

  for (const node of orderedNodes) {
    const nodeState = state.nodes.get(node.id)
    if (nodeState === undefined || nodeState.status === 'done' || nodeState.status === 'skipped') {
      continue
    }
    const order = orderByNode.get(node.id) ?? 0
    if (node.type === 'agent' && nodeState.status === 'running') {
      addTimeLimitChoice({
        world,
        ledger,
        node,
        instanceId: node.id,
        state: nodeState,
        order,
        candidates,
        deviations
      })
      continue
    }
    if (
      (nodeState.status === 'failed' || nodeState.status === 'unverifiable') &&
      hasPendingAnsweredControl(candidates, node.id)
    ) {
      continue
    }
    if (node.type === 'pr-sitter') {
      const detail = world.compositeReadErrors?.[node.id]
      if (detail !== undefined) {
        const result = configurationChoice({ world, ledger, node, state: nodeState, order, detail })
        if (result.deviation !== undefined) {
          addDeviation(deviations, order, result.deviation)
        }
        if (result.candidate !== undefined) {
          candidates.push(result.candidate)
        }
        continue
      }
    }
    if (nodeState.status === 'failed') {
      const expansionFailure =
        node.type === 'swarm' &&
        pipelineAttemptFacts(ledger).some(
          (fact) =>
            fact.identity.instanceId === node.id &&
            fact.identity.epoch === nodeState.epoch &&
            fact.entry.action.kind === 'pipeline-expand-swarm' &&
            fact.entry.state === 'settled' &&
            fact.effect === 'not-landed'
        )
      const cause = expansionFailure ? 'swarm-lint' : 'retries-exhausted'
      const route = routeChoiceForNode({
        world,
        ledger,
        node,
        instanceId: node.id,
        state: nodeState,
        cause,
        detail: nodeState.failure?.reason ?? `Node ${node.id} exhausted its retry budget`,
        order
      })
      if (route.deviation !== undefined) {
        addDeviation(deviations, order, route.deviation)
      }
      if (route.candidate !== undefined) {
        candidates.push(route.candidate)
      }
      continue
    }
    if (node.type === 'pr-sitter') {
      collectPrSitterDecision({
        world,
        ledger,
        node,
        nodeState,
        state,
        order,
        candidates,
        deviations
      })
      continue
    }
    if (node.type === 'gate' && nodeState.status === 'ready') {
      addCandidate(
        candidates,
        world,
        ledger,
        buildGateAction(world, node, node.id, nodeState.epoch, nodeState.attempt),
        2,
        order
      )
      continue
    }
    if (node.type === 'loop' && nodeState.status === 'waiting') {
      const reference = pipelineOutputReference(node.until)
      const verdict =
        reference === null
          ? null
          : loopVerdict(node, {
              [reference.nodeId]: state.nodes.get(reference.nodeId)?.outputs ?? {}
            })
      const cause: PipelineChoiceCause = verdict === 'escalate' ? 'loop-escalate' : 'loop-max'
      const route = routeChoiceForNode({
        world,
        ledger,
        node,
        instanceId: node.id,
        state: nodeState,
        cause,
        detail: `Loop ${node.id} reached ${cause} at round ${nodeState.round ?? 1}`,
        order
      })
      if (route.deviation !== undefined) {
        addDeviation(deviations, order, route.deviation)
      }
      if (route.candidate !== undefined) {
        candidates.push(route.candidate)
      }
      continue
    }
    if (node.type === 'swarm') {
      const expansion = latestSwarmExpansion(world, node.id, nodeState.epoch)
      if (expansion === undefined && nodeState.status === 'ready') {
        const action = buildPipelineSwarmExpansionAction({
          world,
          node,
          state,
          epoch: nodeState.epoch,
          attempt: nodeState.attempt
        })
        addCandidate(candidates, world, ledger, action, 0, order)
        continue
      }
      if (expansion !== undefined) {
        for (const task of expansion.tasks) {
          const childId = nodeInstanceId(node.id, task.id)
          const childState = state.nodes.get(childId)
          if (childState?.status === 'failed') {
            if (hasPendingAnsweredControl(candidates, childId)) {
              continue
            }
            const route = routeChoiceForNode({
              world,
              ledger,
              node,
              instanceId: childId,
              state: childState,
              cause: 'retries-exhausted',
              detail:
                childState.failure?.reason ?? `Swarm child ${childId} exhausted its retry budget`,
              order
            })
            if (route.deviation !== undefined) {
              addDeviation(deviations, order, route.deviation)
            }
            if (route.candidate !== undefined) {
              candidates.push(route.candidate)
            }
          } else if (childState?.status === 'running') {
            addTimeLimitChoice({
              world,
              ledger,
              node,
              instanceId: childId,
              state: childState,
              order,
              candidates,
              deviations
            })
          }
        }
        for (const childId of readySwarmChildren({
          swarmId: node.id,
          tasks: expansion.tasks,
          states: state.nodes,
          maxParallel: node.maxParallel
        })) {
          const taskId = childTaskIdFromInstanceId(childId)
          const task = expansion.tasks.find((candidate) => candidate.id === taskId)
          const childState = state.nodes.get(childId)
          if (task === undefined || childState === undefined) {
            continue
          }
          const action = buildPipelineAgentAction({
            world,
            ledger,
            state,
            node: node.child,
            instanceId: childId,
            epoch: childState.epoch,
            attempt: childState.attempt,
            outputs,
            task: { id: task.id, title: task.title, spec: task.spec },
            sendBackComment: history.sendBackComments.get(childId)
          })
          if (action !== null) {
            addCandidate(
              candidates,
              world,
              ledger,
              action,
              2,
              order + expansion.tasks.findIndex((candidate) => candidate.id === task.id) / 100
            )
          } else {
            const result = configurationChoice({
              world,
              ledger,
              node,
              state: nodeState,
              order,
              detail: `Could not render swarm task ${task.id}`
            })
            if (result.deviation !== undefined) {
              addDeviation(deviations, order, result.deviation)
            }
            if (result.candidate !== undefined) {
              candidates.push(result.candidate)
            }
          }
        }
      }
      continue
    }
    if (node.type === 'merge' && (nodeState.status === 'ready' || nodeState.status === 'waiting')) {
      addMergeCandidates({
        world,
        ledger,
        document,
        node,
        state: nodeState,
        runState: state,
        history,
        order,
        candidates,
        deviations
      })
      continue
    }
    if (node.type === 'agent' && nodeState.status === 'ready') {
      const action = buildPipelineAgentAction({
        world,
        ledger,
        state,
        node,
        instanceId: node.id,
        epoch: nodeState.epoch,
        attempt: nodeState.attempt,
        outputs,
        sendBackComment: history.sendBackComments.get(node.id)
      })
      if (action !== null) {
        addCandidate(candidates, world, ledger, action, 2, order)
      } else {
        const result = configurationChoice({
          world,
          ledger,
          node,
          state: nodeState,
          order,
          detail: `Could not render prompt for ${node.id}`
        })
        if (result.deviation !== undefined) {
          addDeviation(deviations, order, result.deviation)
        }
        if (result.candidate !== undefined) {
          candidates.push(result.candidate)
        }
      }
      continue
    }
    if (node.type === 'check' && nodeState.status === 'ready') {
      addCandidate(
        candidates,
        world,
        ledger,
        buildPipelineCheckAction(world, node, nodeState.epoch, nodeState.attempt),
        2,
        order
      )
      continue
    }
    if (node.type === 'script' && nodeState.status === 'ready') {
      const action = buildPipelineScriptAction({
        world,
        node,
        epoch: nodeState.epoch,
        attempt: nodeState.attempt,
        outputs
      })
      if (action !== null) {
        addCandidate(candidates, world, ledger, action, 2, order)
      } else {
        const result = configurationChoice({
          world,
          ledger,
          node,
          state: nodeState,
          order,
          detail: `Could not resolve Script inputs for ${node.id}`
        })
        if (result.deviation !== undefined) {
          addDeviation(deviations, order, result.deviation)
        }
        if (result.candidate !== undefined) {
          candidates.push(result.candidate)
        }
      }
      continue
    }
    if (node.type === 'land' && nodeState.status === 'ready') {
      const next = buildNextLandAction({
        world,
        ledger,
        outputs,
        node,
        epoch: nodeState.epoch,
        attempt: nodeState.attempt
      })
      if (next.action !== undefined) {
        addCandidate(candidates, world, ledger, next.action, 2, order)
      } else if (next.unavailable !== undefined) {
        const result = configurationChoice({
          world,
          ledger,
          node,
          state: nodeState,
          order,
          detail: next.unavailable
        })
        if (result.deviation !== undefined) {
          addDeviation(deviations, order, result.deviation)
        }
        if (result.candidate !== undefined) {
          candidates.push(result.candidate)
        }
      }
    }
  }

  if (deviations.length > 0) {
    deviations.sort((left, right) => left.order - right.order)
    const preferred =
      preferredNodeInstanceId === undefined
        ? undefined
        : deviations.find(
            ({ deviation }) =>
              deviation.kind === 'pipeline-node' &&
              deviation.nodeInstanceId === preferredNodeInstanceId
          )
    const deviation = preferred?.deviation ?? deviations[0]?.deviation
    if (deviation !== undefined) {
      return { action: null, deviation }
    }
  }
  candidates.sort((left, right) => left.stage - right.stage || left.order - right.order)
  const candidate = candidates[0]
  return candidate === undefined ? noDecision() : { action: candidate.action }
}
export function decidePipelineTick(
  world: PipelineWorld,
  ledger: WatcherLedger
): DecisionOutcome<KernelAction> {
  return decidePipelineTickInternal(world, ledger)
}

export function decidePipelineNodeDeviation(
  world: PipelineWorld,
  ledger: WatcherLedger,
  nodeInstanceId: string
): PipelineNodeDeviation | null {
  const decision = decidePipelineTickInternal(world, ledger, nodeInstanceId)
  return 'deviation' in decision &&
    decision.deviation.kind === 'pipeline-node' &&
    decision.deviation.nodeInstanceId === nodeInstanceId
    ? decision.deviation
    : null
}
